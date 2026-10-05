import { performance } from "node:perf_hooks";
import type { MaritimeVessel } from "@workspace/db";
import type { FuelProfile, OptimizeInput } from "@workspace/api-zod";
type Candidate = {
  fuelId: string;
  fuelName: string;
  speedKnots: number;
  fuelMassTonnes: number;
  fuelVolumeM3: number;
  totalCostInr: number;
  wellToWakeKgCo2e: number;
  tankToWakeKgCo2e: number;
  durationHours: number;
  engineLoadFraction: number;
  feasible: boolean;
  score: number;
};
type Physics = {
  basePowerKw: number;
  windAddedPowerKw: number;
  waveAddedPowerKw: number;
  currentAdjustedSpeedKnots: number;
  draftPowerFactor: number;
};
type Individual = {
  speed: number;
  fuelIndex: number;
  velocitySpeed: number;
  velocityFuel: number;
  bestSpeed: number;
  bestFuelIndex: number;
  bestScore: number;
};

const RHO_AIR_KG_M3 = 1.226;
const RHO_SEAWATER_KG_M3 = 1025;
const GRAVITY_M_S2 = 9.80665;
const KNOT_TO_M_S = 0.514444;
const REFERENCE_FUEL_LHV_MJ_KG = 40.2;
const FOSSIL_METHANE_GWP100 = 29.8;

const fuelProfiles: FuelProfile[] = [
  {
    fuelId: "vlsfo",
    name: "VLSFO",
    lowerHeatingValueMjKg: 40.2,
    tankToWakeKgCo2PerKg: 3.114,
    volumetricStoragePenalty: 1,
    methaneSlipInputRequired: false,
    reference:
      "LHV and CO₂ factor supplied in the project brief; residual-oil CO₂ factor is also in IMO MEPC.281(70).",
  },
  {
    fuelId: "hfo",
    name: "HFO",
    lowerHeatingValueMjKg: 40.2,
    tankToWakeKgCo2PerKg: 3.114,
    volumetricStoragePenalty: 1,
    methaneSlipInputRequired: false,
    reference: "IMO MEPC.281(70), HFO residual-fuel reference values.",
  },
  {
    fuelId: "lng",
    name: "LNG",
    lowerHeatingValueMjKg: 49.2,
    tankToWakeKgCo2PerKg: 2.75,
    volumetricStoragePenalty: null,
    methaneSlipInputRequired: true,
    reference:
      "LHV and CO₂ factor supplied in the project brief; methane slip is engine- and load-dependent and must be sourced for each run.",
  },
  {
    fuelId: "green-methanol",
    name: "E-methanol / green methanol",
    lowerHeatingValueMjKg: 19.9,
    tankToWakeKgCo2PerKg: 1.375,
    volumetricStoragePenalty: 2.1,
    methaneSlipInputRequired: false,
    reference:
      "LHV and storage penalty supplied in the project brief; TtW carbon factor from IMO MEPC.281(70). Enter pathway-specific WtT data.",
  },
  {
    fuelId: "liquid-hydrogen",
    name: "Liquid hydrogen",
    lowerHeatingValueMjKg: 120,
    tankToWakeKgCo2PerKg: 0,
    volumetricStoragePenalty: 4.3,
    methaneSlipInputRequired: false,
    reference:
      "LHV and storage penalty supplied in the project brief; zero direct CO₂ at combustion. WtT factor depends on production pathway.",
  },
  {
    fuelId: "ammonia",
    name: "Ammonia",
    lowerHeatingValueMjKg: 18.6,
    tankToWakeKgCo2PerKg: 0,
    volumetricStoragePenalty: null,
    methaneSlipInputRequired: false,
    reference:
      "LHV from MAN Energy Solutions; no generic storage penalty is assumed. TtW CO₂ is zero; add sourced non-CO₂ TtW emissions where applicable.",
  },
];

const classLabels = ["ulcs", "capesize", "suezmax", "feeder", "other"];

export function getMaritimeCatalog() {
  return {
    vesselClasses: classLabels,
    fuels: fuelProfiles,
    methodology: [
      "Calm-water shaft power follows the requested cubic speed law with draft correction: P = Pdesign × (V/Vdesign)^3 × (T/Tdesign)^(2/3).",
      "Wind drag uses operator-entered 10 m wind speed and a separate relative wind direction, with projected area and drag coefficient.",
      "Wave added resistance is an explicitly simplified directional screening estimate; IMO MEPC.1/Circ.796 recommends vessel-specific simulation or equivalent test data for decision-grade wave resistance.",
      "SFOC is piecewise-linearly interpolated from the vessel's sourced load curve. Alternative-fuel mass is adjusted by LHV on an energy-equivalent basis.",
      "Well-to-wake GHG = user-sourced well-to-tank factor + tank-to-wake CO₂ + user-entered non-CO₂ TtW factor + LNG methane slip using fossil methane GWP100 = 29.8.",
      "FuelCast estimates total measured onboard fuel rate for three named vessels only; it is a separate reference and does not change fuel-specific cost ranking.",
      "The optimization is categorical/discrete and is a classical software heuristic; it does not use a quantum computer or establish regulatory compliance.",
    ],
    provenanceNotice:
      "No fleet records or bunker prices are preloaded. The uploaded model README marks its sample fleet and training data as synthetic, so those records are excluded. Add vessel records with a source citation, then enter dated, sourced INR fuel-price and lifecycle inputs for each run. FuelCast source data is kept local and is not bundled.",
  };
}

function sfocAtLoad(curve: MaritimeVessel["sfocCurve"], load: number): number {
  const sorted = [...curve].sort((a, b) => a.loadFraction - b.loadFraction);
  if (
    sorted.length < 2 ||
    load < sorted[0]!.loadFraction ||
    load > sorted[sorted.length - 1]!.loadFraction
  ) {
    return Number.NaN;
  }
  const upper = sorted.findIndex((point) => point.loadFraction >= load);
  if (upper <= 0) return sorted[0]!.gramsPerKwh;
  const lowerPoint = sorted[upper - 1]!;
  const upperPoint = sorted[upper]!;
  const fraction =
    (load - lowerPoint.loadFraction) /
    (upperPoint.loadFraction - lowerPoint.loadFraction);
  return lowerPoint.gramsPerKwh + fraction * (upperPoint.gramsPerKwh - lowerPoint.gramsPerKwh);
}

function getPhysics(
  vessel: MaritimeVessel,
  input: OptimizeInput,
  speedKnots: number,
): Physics {
  const speedMs = speedKnots * KNOT_TO_M_S;
  const windMs = input.windSpeed10mMPerS;
  const windDirectionRad = (input.windRelativeDirectionDeg * Math.PI) / 180;
  const waveDirectionRad = (input.waveRelativeDirectionDeg * Math.PI) / 180;
  const relativeWindSquared = Math.max(
    0,
    windMs ** 2 + speedMs ** 2 + 2 * windMs * speedMs * Math.cos(windDirectionRad),
  );
  const windForceN =
    0.5 *
    RHO_AIR_KG_M3 *
    vessel.windageAreaM2 *
    vessel.windDragCoefficient *
    (relativeWindSquared - speedMs ** 2);

  const draftPowerFactor = (input.actualDraftM / vessel.designDraftM) ** (2 / 3);
  const speedPowerFactor = (speedKnots / vessel.designServiceSpeedKnots) ** 3;
  const basePowerKw =
    vessel.maxEnginePowerKw *
    vessel.engineEfficiency *
    speedPowerFactor *
    draftPowerFactor;
  const windAddedPowerKw =
    (windForceN * speedMs) / 1000 / vessel.engineEfficiency;

  // A pressure-scale, hull-form, and direction-based screening proxy; not a
  // substitute for the ship-specific wave-resistance tests described by IMO.
  const headWaveFactor = Math.max(0, Math.cos(waveDirectionRad)) ** 2;
  const waveForceN =
    0.5 *
    RHO_SEAWATER_KG_M3 *
    GRAVITY_M_S2 *
    input.waveHeightM ** 2 *
    vessel.beamM *
    vessel.blockCoefficient *
    headWaveFactor *
    (input.waveHeightM / vessel.lengthOverallM);
  const waveAddedPowerKw =
    (waveForceN * speedMs) / 1000 / vessel.engineEfficiency;

  return {
    basePowerKw,
    windAddedPowerKw,
    waveAddedPowerKw,
    currentAdjustedSpeedKnots: speedKnots + input.currentAlongTrackKnots,
    draftPowerFactor,
  };
}

function normalizedObjective(
  candidate: Omit<Candidate, "score">,
  ranges: { cost: [number, number]; emissions: [number, number]; duration: [number, number] },
  weights: OptimizeInput["objectiveWeights"],
): number {
  const normalize = (value: number, bounds: [number, number]) =>
    bounds[1] === bounds[0] ? 0 : (value - bounds[0]) / (bounds[1] - bounds[0]);
  const weightSum = weights.cost + weights.emissions + weights.duration;
  if (weightSum <= 0) return Number.POSITIVE_INFINITY;
  return (
    (weights.cost * normalize(candidate.totalCostInr, ranges.cost) +
      weights.emissions *
        normalize(candidate.wellToWakeKgCo2e, ranges.emissions) +
      weights.duration * normalize(candidate.durationHours, ranges.duration)) /
    weightSum
  );
}

function dominates(left: Candidate, right: Candidate): boolean {
  const noWorse =
    left.totalCostInr <= right.totalCostInr &&
    left.wellToWakeKgCo2e <= right.wellToWakeKgCo2e &&
    left.durationHours <= right.durationHours;
  const strictlyBetter =
    left.totalCostInr < right.totalCostInr ||
    left.wellToWakeKgCo2e < right.wellToWakeKgCo2e ||
    left.durationHours < right.durationHours;
  return noWorse && strictlyBetter;
}

function pareto(candidates: Candidate[]): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.fuelId,
      candidate.speedKnots.toFixed(4),
      candidate.totalCostInr.toFixed(4),
      candidate.wellToWakeKgCo2e.toFixed(4),
    ].join("|");
    if (!unique.has(key)) unique.set(key, candidate);
  }
  const items = [...unique.values()];
  const front = items.filter(
    (candidate, index) =>
      !items.some((other, otherIndex) => otherIndex !== index && dominates(other, candidate)),
  );
  front.sort((a, b) => a.totalCostInr - b.totalCostInr);
  return front;
}

function downsample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) =>
    items[Math.round((index * (items.length - 1)) / (limit - 1))]!,
  );
}

function hypervolume(front: Candidate[], feasible: Candidate[]): number {
  if (!front.length || !feasible.length) return 0;
  const minMax = (key: "totalCostInr" | "wellToWakeKgCo2e" | "durationHours") => {
    const values = feasible.map((item) => item[key]);
    return [Math.min(...values), Math.max(...values)] as [number, number];
  };
  const bounds = {
    x: minMax("totalCostInr"),
    y: minMax("wellToWakeKgCo2e"),
    z: minMax("durationHours"),
  };
  const normalize = (value: number, [min, max]: [number, number]) =>
    max === min ? 0 : (value - min) / (max - min);
  const ref = 1.05;
  const points = front.map((item) => ({
    x: normalize(item.totalCostInr, bounds.x),
    y: normalize(item.wellToWakeKgCo2e, bounds.y),
    z: normalize(item.durationHours, bounds.z),
  }));
  const xSlices = [...new Set(points.map((point) => point.x).filter((x) => x < ref))].sort(
    (a, b) => a - b,
  );
  let volume = 0;
  for (let index = 0; index < xSlices.length; index += 1) {
    const x = xSlices[index]!;
    const nextX = xSlices[index + 1] ?? ref;
    const active = points.filter((point) => point.x <= x);
    const ySlices = [...new Set(active.map((point) => point.y).filter((y) => y < ref))].sort(
      (a, b) => a - b,
    );
    let area = 0;
    for (let yIndex = 0; yIndex < ySlices.length; yIndex += 1) {
      const y = ySlices[yIndex]!;
      const nextY = ySlices[yIndex + 1] ?? ref;
      const minimumZ = Math.min(...active.filter((point) => point.y <= y).map((point) => point.z));
      area += Math.max(0, nextY - y) * Math.max(0, ref - minimumZ);
    }
    volume += Math.max(0, nextX - x) * area;
  }
  return volume;
}

function seededRandom(seedValue: number): () => number {
  let state = seedValue >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function toParetoPoint(candidate: Candidate) {
  const {
    score: _score,
    ...point
  } = candidate;
  return point;
}

export function optimizeVoyage(
  vessel: MaritimeVessel,
  input: OptimizeInput,
) {
  if (input.cargoTonnes > vessel.cargoCapacityTonnes) {
    throw new Error("Cargo exceeds this vessel's source-entered cargo capacity.");
  }
  if (Math.abs(input.currentAlongTrackKnots) > input.currentSpeedKnots + 1e-9) {
    throw new Error("Along-track current cannot exceed the entered current-speed magnitude.");
  }
  if (input.minSpeedKnots > input.maxSpeedKnots) {
    throw new Error("Minimum speed must not exceed maximum speed.");
  }
  if (input.maxSpeedKnots > vessel.maxSpeedKnots) {
    throw new Error("The requested speed range exceeds the vessel's sourced maximum speed.");
  }
  if (
    input.berthWindowStartHour > input.berthWindowEndHour ||
    input.berthWindowEndHour <= 0
  ) {
    throw new Error("The berth slot end must be later than the slot start.");
  }
  const weightSum =
    input.objectiveWeights.cost +
    input.objectiveWeights.emissions +
    input.objectiveWeights.duration;
  if (weightSum <= 0) throw new Error("At least one objective weight must be positive.");

  const selectedFuelIds = new Set(input.fuels.map((fuel) => fuel.fuelId));
  if (selectedFuelIds.size !== input.fuels.length) {
    throw new Error("Each fuel can only be listed once.");
  }
  const profilesById = new Map(fuelProfiles.map((fuel) => [fuel.fuelId, fuel]));
  for (const fuel of input.fuels) {
    const profile = profilesById.get(fuel.fuelId);
    if (!profile) throw new Error(`Unsupported fuel identifier: ${fuel.fuelId}.`);
    if (profile.methaneSlipInputRequired && fuel.methaneSlipPercent === null) {
      throw new Error(`${profile.name} requires a sourced methane-slip percentage.`);
    }
    if (!profile.methaneSlipInputRequired && fuel.methaneSlipPercent !== null) {
      throw new Error(`${profile.name} does not use the LNG methane-slip field.`);
    }
  }
  const compatibleFuelChoices = input.fuels.filter((choice) => {
    const profile = profilesById.get(choice.fuelId);
    return (
      profile &&
      profile.lowerHeatingValueMjKg !== null &&
      profile.tankToWakeKgCo2PerKg !== null &&
      vessel.fuelCompatibility.includes(choice.fuelId) &&
      choice.availableAtBunkeringPort &&
      vessel.fuelTankVolumesM3[choice.fuelId] !== undefined
    );
  });
  if (!compatibleFuelChoices.length) {
    throw new Error(
      "No selected fuel has a sourced price and lifecycle input, port availability, vessel compatibility, and a defined tank volume.",
    );
  }
  if (input.fuels.some((fuel) => !fuel.bunkerPriceSource.trim() || !fuel.wellToTankSource.trim())) {
    throw new Error("Fuel price and well-to-tank values must include source details.");
  }

  const speedCount =
    Math.floor((input.maxSpeedKnots - input.minSpeedKnots) / input.speedStepKnots) + 1;
  if (speedCount < 1 || speedCount > 1200) {
    throw new Error("The speed step creates too many candidates; use at most 1,200 speeds.");
  }
  const speeds = Array.from(
    { length: speedCount },
    (_, index) => input.minSpeedKnots + index * input.speedStepKnots,
  );
  const lastSpeed = speeds[speeds.length - 1]!;
  if (input.maxSpeedKnots - lastSpeed > input.speedStepKnots * 0.25) {
    speeds.push(input.maxSpeedKnots);
  }

  const evaluate = (speed: number, fuelIndex: number): Candidate => {
    const fuel = compatibleFuelChoices[Math.max(0, Math.min(compatibleFuelChoices.length - 1, Math.round(fuelIndex)))]!;
    const profile = profilesById.get(fuel.fuelId)!;
    const physics = getPhysics(vessel, input, speed);
    const throughWaterSpeed = physics.currentAdjustedSpeedKnots;
    const sailingDurationHours =
      throughWaterSpeed > 0 ? input.distanceNm / throughWaterSpeed : Number.POSITIVE_INFINITY;
    const durationHours = Math.max(sailingDurationHours, input.berthWindowStartHour);
    const requiredEnginePowerKw =
      (physics.basePowerKw + physics.windAddedPowerKw + physics.waveAddedPowerKw) /
      vessel.engineEfficiency;
    const engineLoadFraction = requiredEnginePowerKw / vessel.maxEnginePowerKw;
    const sfoc = sfocAtLoad(vessel.sfocCurve, engineLoadFraction);
    const fuelMassTonnes =
      (requiredEnginePowerKw *
        sailingDurationHours *
        sfoc *
        (REFERENCE_FUEL_LHV_MJ_KG / profile.lowerHeatingValueMjKg!)) /
      1_000_000;
    const fuelVolumeM3 = (fuelMassTonnes * 1000) / fuel.densityKgPerM3;
    const weightPenalty =
      vessel.alternativeFuelWeightPenaltyTonnes[fuel.fuelId] ?? 0;
    const tankCapacity = vessel.fuelTankVolumesM3[fuel.fuelId] ?? 0;
    const methaneSlipFraction =
      profile.methaneSlipInputRequired
        ? (fuel.methaneSlipPercent ?? 0) / 100
        : 0;
    const tankToWakeKgCo2e =
      fuelMassTonnes *
        1000 *
        profile.tankToWakeKgCo2PerKg! *
        (1 - methaneSlipFraction) +
      fuelMassTonnes * 1000 * methaneSlipFraction * FOSSIL_METHANE_GWP100 +
      fuelMassTonnes * 1000 * fuel.nonCo2TankToWakeKgCo2ePerKg;
    const wellToWakeKgCo2e =
      fuelMassTonnes * 1000 * fuel.wellToTankKgCo2ePerKg + tankToWakeKgCo2e;
    const fuelCostInr = fuelMassTonnes * fuel.bunkerPriceInrPerTonne;
    const carbonCostInr =
      Math.max(0, wellToWakeKgCo2e) * (input.carbonPriceInrPerTonne / 1000);
    const totalCostInr = fuelCostInr + carbonCostInr + input.portFeesInr;
    const arrivalWithinWindow =
      sailingDurationHours <= input.berthWindowEndHour &&
      Number.isFinite(sailingDurationHours);
    const feasible =
      Number.isFinite(sfoc) &&
      engineLoadFraction > 0 &&
      engineLoadFraction <= 1 &&
      durationHours > 0 &&
      arrivalWithinWindow &&
      fuelVolumeM3 <= tankCapacity &&
      input.cargoTonnes + fuelMassTonnes + weightPenalty <= vessel.deadweightTonnes;
    return {
      fuelId: profile.fuelId,
      fuelName: profile.name,
      speedKnots: speed,
      fuelMassTonnes,
      fuelVolumeM3,
      totalCostInr,
      wellToWakeKgCo2e,
      tankToWakeKgCo2e,
      durationHours,
      engineLoadFraction,
      feasible,
      score: Number.POSITIVE_INFINITY,
    };
  };

  const gridCandidates: Candidate[] = [];
  for (const speed of speeds) {
    for (let fuelIndex = 0; fuelIndex < compatibleFuelChoices.length; fuelIndex += 1) {
      const candidate = evaluate(speed, fuelIndex);
      if (candidate.feasible) gridCandidates.push(candidate);
    }
  }
  if (!gridCandidates.length) {
    throw new Error(
      "No feasible plan exists for these inputs. Check draft, cargo, engine load curve, fuel tank volume, fuel compatibility, and berth window.",
    );
  }

  const ranges = {
    cost: [
      Math.min(...gridCandidates.map((item) => item.totalCostInr)),
      Math.max(...gridCandidates.map((item) => item.totalCostInr)),
    ] as [number, number],
    emissions: [
      Math.min(...gridCandidates.map((item) => item.wellToWakeKgCo2e)),
      Math.max(...gridCandidates.map((item) => item.wellToWakeKgCo2e)),
    ] as [number, number],
    duration: [
      Math.min(...gridCandidates.map((item) => item.durationHours)),
      Math.max(...gridCandidates.map((item) => item.durationHours)),
    ] as [number, number],
  };
  const scoreCandidate = (candidate: Candidate) => ({
    ...candidate,
    score: normalizedObjective(candidate, ranges, input.objectiveWeights),
  });
  const exactGrid = gridCandidates.map(scoreCandidate);

  const populationSize = 20;
  const generations = Math.max(2, Math.floor(input.evaluationBudget / populationSize));

  const runPopulation = (
    algorithm: "QPSO" | "GA" | "PSO",
    seed: number,
  ) => {
    const start = performance.now();
    const random = seededRandom(seed);
    let population = Array.from({ length: populationSize }, () => {
      const initial = gridCandidates[Math.floor(random() * gridCandidates.length)]!;
      return {
        speed: initial.speedKnots,
        fuelIndex: compatibleFuelChoices.findIndex(
          (fuel) => fuel.fuelId === initial.fuelId,
        ),
        velocitySpeed: 0,
        velocityFuel: 0,
        bestSpeed: Number.NaN,
        bestFuelIndex: 0,
        bestScore: Number.POSITIVE_INFINITY,
      };
    });
    const discovered: Candidate[] = [];
    const convergence: {
      iteration: number;
      bestCostInr: number;
      bestWellToWakeKgCo2e: number;
      bestDurationHours: number;
    }[] = [];
    let globalBest: Candidate | null = null;
    let globalBestSpeed = input.minSpeedKnots;
    let globalBestFuel = 0;
    let evaluations = 0;
    let lastImprovement = 0;
    let lastScore = Number.POSITIVE_INFINITY;

    const evaluatePopulation = () => {
      for (const individual of population) {
        const candidate = evaluate(individual.speed, individual.fuelIndex);
        evaluations += 1;
        if (!candidate.feasible) continue;
        const scored = scoreCandidate(candidate);
        discovered.push(scored);
        if (scored.score < individual.bestScore) {
          individual.bestScore = scored.score;
          individual.bestSpeed = individual.speed;
          individual.bestFuelIndex = Math.round(individual.fuelIndex);
        }
        if (!globalBest || scored.score < globalBest.score) {
          globalBest = scored;
          globalBestSpeed = individual.speed;
          globalBestFuel = Math.round(individual.fuelIndex);
        }
      }
    };

    for (let generation = 1; generation <= generations; generation += 1) {
      evaluatePopulation();
      const currentBest = globalBest as Candidate | null;
      if (!currentBest) continue;
      if (currentBest.score < lastScore - 1e-10) {
        lastScore = currentBest.score;
        lastImprovement = generation;
      }
      const best = currentBest;
      convergence.push({
        iteration: generation,
        bestCostInr: best.totalCostInr,
        bestWellToWakeKgCo2e: best.wellToWakeKgCo2e,
        bestDurationHours: best.durationHours,
      });

      if (algorithm === "QPSO") {
        const meanBestSpeed =
          population.reduce(
            (sum, individual) =>
              sum +
              (Number.isFinite(individual.bestSpeed) ? individual.bestSpeed : globalBestSpeed),
            0,
          ) / populationSize;
        for (const individual of population) {
          const localAttractor =
            random() * individual.bestSpeed +
            (1 - random()) * globalBestSpeed;
          const beta = 0.75 - 0.4 * (generation / generations);
          const magnitude =
            beta *
            Math.abs(meanBestSpeed - individual.speed) *
            Math.log(1 / Math.max(random(), 1e-8));
          individual.speed = Math.min(
            input.maxSpeedKnots,
            Math.max(input.minSpeedKnots, localAttractor + (random() < 0.5 ? -magnitude : magnitude)),
          );
          individual.fuelIndex =
            random() < 0.6
              ? (random() < 0.5 ? individual.bestFuelIndex : globalBestFuel)
              : Math.floor(random() * compatibleFuelChoices.length);
        }
      } else if (algorithm === "GA") {
        const sorted = [...population].sort((a, b) => a.bestScore - b.bestScore);
        const tournament = () =>
          [sorted[Math.floor(random() * sorted.length)]!, sorted[Math.floor(random() * sorted.length)]!]
            .sort((a, b) => a.bestScore - b.bestScore)[0]!;
        const next: Individual[] = [
          { ...sorted[0]!, speed: sorted[0]!.bestSpeed, fuelIndex: sorted[0]!.bestFuelIndex },
        ];
        while (next.length < populationSize) {
          const first = tournament();
          const second = tournament();
          const blend = random();
          const childSpeed = first.bestSpeed * blend + second.bestSpeed * (1 - blend);
          const childFuel =
            random() < 0.5 ? first.bestFuelIndex : second.bestFuelIndex;
          const mutated =
            random() < 0.12
              ? input.minSpeedKnots + random() * (input.maxSpeedKnots - input.minSpeedKnots)
              : childSpeed;
          const fuelMutation =
            random() < 0.12
              ? Math.floor(random() * compatibleFuelChoices.length)
              : childFuel;
          next.push({
            speed: mutated,
            fuelIndex: fuelMutation,
            velocitySpeed: 0,
            velocityFuel: 0,
            bestSpeed: Number.NaN,
            bestFuelIndex: 0,
            bestScore: Number.POSITIVE_INFINITY,
          });
        }
        population = next;
      } else {
        for (const individual of population) {
          const r1 = random();
          const r2 = random();
          individual.velocitySpeed =
            0.65 * individual.velocitySpeed +
            1.4 * r1 * (individual.bestSpeed - individual.speed) +
            1.4 * r2 * (globalBestSpeed - individual.speed);
          individual.velocityFuel =
            0.5 * individual.velocityFuel +
            1.2 * r1 * (individual.bestFuelIndex - individual.fuelIndex) +
            1.2 * r2 * (globalBestFuel - individual.fuelIndex);
          individual.speed = Math.min(
            input.maxSpeedKnots,
            Math.max(input.minSpeedKnots, individual.speed + individual.velocitySpeed),
          );
          individual.fuelIndex = Math.min(
            compatibleFuelChoices.length - 1,
            Math.max(0, individual.fuelIndex + individual.velocityFuel),
          );
        }
      }
    }

    if (!globalBest) {
      throw new Error(`${algorithm} failed to find a feasible plan.`);
    }
    return {
      algorithm:
        algorithm === "QPSO"
          ? "Quantum-inspired PSO (QPSO)"
          : algorithm === "GA"
            ? "Genetic algorithm (GA)"
            : "Classical particle swarm (PSO)",
      runtimeSeconds: (performance.now() - start) / 1000,
      convergenceIterations: Math.max(1, lastImprovement),
      evaluations,
      paretoHypervolume: hypervolume(pareto(discovered), exactGrid),
      selectedPlan: toParetoPoint(globalBest),
      convergence,
      paretoFront: downsample(pareto(discovered).map(toParetoPoint), 120),
    };
  };

  const benchmarkResults = [
    runPopulation("QPSO", input.randomSeed + 11),
    runPopulation("GA", input.randomSeed + 23),
    runPopulation("PSO", input.randomSeed + 37),
  ];

  const greedyStart = performance.now();
  const serviceSpeed = Math.min(
    input.maxSpeedKnots,
    Math.max(input.minSpeedKnots, vessel.designServiceSpeedKnots),
  );
  const uniformCandidates = compatibleFuelChoices
    .map((_, fuelIndex) => scoreCandidate(evaluate(serviceSpeed, fuelIndex)))
    .filter((candidate) => candidate.feasible);
  const greedyBest = (uniformCandidates.length ? uniformCandidates : exactGrid).reduce(
    (best, candidate) => (candidate.score < best.score ? candidate : best),
  );
  const greedyFront = pareto(uniformCandidates.length ? uniformCandidates : exactGrid);
  benchmarkResults.push({
    algorithm: "Greedy uniform-service-speed",
    runtimeSeconds: (performance.now() - greedyStart) / 1000,
    convergenceIterations: 1,
    evaluations: uniformCandidates.length
      ? compatibleFuelChoices.length
      : exactGrid.length,
    paretoHypervolume: hypervolume(greedyFront, exactGrid),
    selectedPlan: toParetoPoint(greedyBest),
    convergence: [
      {
        iteration: 1,
        bestCostInr: greedyBest.totalCostInr,
        bestWellToWakeKgCo2e: greedyBest.wellToWakeKgCo2e,
        bestDurationHours: greedyBest.durationHours,
      },
    ],
    paretoFront: downsample(greedyFront.map(toParetoPoint), 120),
  });

  const recommended = benchmarkResults[0]!.selectedPlan;
  const recommendedPhysics = getPhysics(vessel, input, recommended.speedKnots);
  const allFeasible = exactGrid;
  const fullPareto = pareto(allFeasible);
  return {
    vessel: {
      ...vessel,
      createdAt: vessel.createdAt.toISOString(),
      updatedAt: vessel.updatedAt.toISOString(),
    },
    recommendedPlan: recommended,
    benchmarkResults,
    paretoFront: downsample(fullPareto.map(toParetoPoint), 250),
    physics: {
      ...recommendedPhysics,
      windAddedPowerKw:
        Number.isFinite(recommendedPhysics.windAddedPowerKw)
          ? recommendedPhysics.windAddedPowerKw
          : 0,
    },
    warnings: [
      "This is a screening model, not an engineering certification, safety approval, or regulatory compliance calculation.",
      "Wave added resistance is a simplified directional proxy. IMO MEPC.1/Circ.796 recommends ship-specific simulations or equivalent test data for decision-grade wave resistance.",
      "Well-to-tank, bunkering prices, methane slip, and non-CO₂ exhaust values are user-entered and are not independently verified by this app.",
      "The Pareto hypervolume is computed in normalized cost, emissions, and duration space against a 1.05 reference point.",
    ],
  };
}