from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
from typing import Any

import joblib
import numpy as np
import pandas as pd
import pyarrow.parquet as parquet
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = ROOT / ".local/fuelcast/data"
DATA_DIR = Path(os.environ.get("FUELCAST_DATA_DIR", DEFAULT_DATA_DIR))
ARTIFACT_DIR = Path(os.environ.get("FUELCAST_ARTIFACT_DIR", ROOT / ".local/fuelcast"))
MODEL_PATH = ARTIFACT_DIR / "fuelcast_model.joblib"
REPORT_PATH = ARTIFACT_DIR / "validation.json"
TARGET = "Consumer_Total_MomentaryFuel"
FEATURES = [
    "Consumer_Total_ShaftPower",
    "Ship_SpeedOverGround",
    "Weather_WindSpeed10M",
    "Weather_WaveHeight",
    "Weather_OceanCurrentVelocity",
]
VESSEL_FILES = {
    "CPS_Poseidon.parquet": "CPS Poseidon",
    "CPS_Triton.parquet": "CPS Triton",
    "OSS_Ceto.parquet": "OSS Ceto",
}
MODEL_NAME = "HistGradientBoostingRegressor"
MODEL_PARAMETERS = {
    "max_iter": 100,
    "max_leaf_nodes": 31,
    "l2_regularization": 1.0,
    "random_state": 42,
}


def load_dataset() -> tuple[pd.DataFrame, dict[str, Any]]:
    if not DATA_DIR.is_dir():
        raise FileNotFoundError(f"FuelCast data directory not found: {DATA_DIR}")

    frames: list[pd.DataFrame] = []
    input_counts: dict[str, int] = {}
    excluded_counts: dict[str, int] = {}
    for filename, vessel in VESSEL_FILES.items():
        path = DATA_DIR / filename
        if not path.is_file():
            raise FileNotFoundError(f"Required FuelCast vessel file not found: {path}")
        schema = parquet.ParquetFile(path).schema_arrow
        required = ["index", TARGET, *FEATURES]
        missing = [column for column in required if column not in schema.names]
        if missing:
            raise ValueError(f"{filename} is missing required schema fields: {missing}")

        frame = pd.read_parquet(path, columns=required)
        input_counts[vessel] = len(frame)
        frame["_vessel"] = vessel
        frame["_source_order"] = pd.to_numeric(frame["index"], errors="coerce")
        for column in [TARGET, *FEATURES]:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
        numeric = frame[["_source_order", TARGET, *FEATURES]].to_numpy(dtype=float)
        valid = np.isfinite(numeric).all(axis=1) & (frame[TARGET].to_numpy() >= 0)
        excluded_counts[vessel] = int((~valid).sum())
        frame = frame.loc[valid].copy()
        if frame["_source_order"].duplicated().any():
            raise ValueError(f"{filename} has duplicate source-order indices.")
        frame.sort_values("_source_order", kind="stable", inplace=True)
        frames.append(frame[["_vessel", "_source_order", TARGET, *FEATURES]])

    data = pd.concat(frames, ignore_index=True)
    metadata = {
        "inputCounts": input_counts,
        "excludedCounts": excluded_counts,
        "observationsLoaded": sum(input_counts.values()),
        "observationsUsable": len(data),
        "observationsExcluded": sum(excluded_counts.values()),
        "vesselCount": data["_vessel"].nunique(),
        "vessels": sorted(data["_vessel"].unique().tolist()),
    }
    if data.empty or metadata["vesselCount"] != len(VESSEL_FILES):
        raise ValueError("FuelCast validation produced no data or an unexpected vessel count.")
    return data, metadata


def make_model() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(**MODEL_PARAMETERS)


def metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float | None | int]:
    has_zero = bool(np.any(actual == 0))
    return {
        "observations": int(len(actual)),
        "maeKgPerSecond": float(mean_absolute_error(actual, predicted)),
        "rmseKgPerSecond": float(math.sqrt(mean_squared_error(actual, predicted))),
        "r2": float(r2_score(actual, predicted)),
        "mapePercent": (
            None
            if has_zero
            else float(np.mean(np.abs((actual - predicted) / actual)) * 100)
        ),
        "mapeUnavailableReason": (
            "Measured fuel-rate targets include zero; percentage error is undefined."
            if has_zero
            else None
        ),
    }


def evaluate(data: pd.DataFrame, metadata: dict[str, Any]) -> tuple[dict[str, Any], HistGradientBoostingRegressor]:
    training_parts: list[pd.DataFrame] = []
    test_parts: list[pd.DataFrame] = []
    for _, vessel_data in data.groupby("_vessel", sort=True):
        split = int(len(vessel_data) * 0.8)
        if split == 0 or split == len(vessel_data):
            raise ValueError("Each vessel needs enough ordered observations for an 80/20 split.")
        training_parts.append(vessel_data.iloc[:split])
        test_parts.append(vessel_data.iloc[split:])

    training = pd.concat(training_parts, ignore_index=True)
    testing = pd.concat(test_parts, ignore_index=True)
    time_model = make_model()
    time_model.fit(training[FEATURES], training[TARGET])
    time_predictions = time_model.predict(testing[FEATURES])
    time_metrics = metrics(testing[TARGET].to_numpy(), time_predictions)
    per_vessel = {}
    time_blocks = {}
    for vessel, block in testing.groupby("_vessel", sort=True):
        mask = testing["_vessel"].to_numpy() == vessel
        vessel_metrics = metrics(block[TARGET].to_numpy(), time_predictions[mask])
        per_vessel[vessel] = vessel_metrics
        time_blocks[vessel] = {
            "sourceOrderStart": int(block["_source_order"].min()),
            "sourceOrderEnd": int(block["_source_order"].max()),
            **vessel_metrics,
        }

    oov_predictions: list[np.ndarray] = []
    oov_actual: list[np.ndarray] = []
    oov_folds: list[dict[str, Any]] = []
    for vessel in metadata["vessels"]:
        held_out = data[data["_vessel"] == vessel]
        fold_training = data[data["_vessel"] != vessel]
        fold_model = make_model()
        fold_model.fit(fold_training[FEATURES], fold_training[TARGET])
        fold_predictions = fold_model.predict(held_out[FEATURES])
        oov_predictions.append(fold_predictions)
        oov_actual.append(held_out[TARGET].to_numpy())
        oov_folds.append(
            {
                "heldOutVessel": vessel,
                "trainingObservations": int(len(fold_training)),
                "testObservations": int(len(held_out)),
                **metrics(held_out[TARGET].to_numpy(), fold_predictions),
            }
        )

    oov_metrics = metrics(np.concatenate(oov_actual), np.concatenate(oov_predictions))
    deployment_model = make_model()
    deployment_model.fit(data[FEATURES], data[TARGET])
    report = {
        "dataset": "FuelCast",
        "target": TARGET,
        "targetUnit": "kg/s",
        "features": FEATURES,
        "model": MODEL_NAME,
        "modelParameters": MODEL_PARAMETERS,
        "validation": {
            "chronologicalMethod": "Per-vessel final 20% by stored source row order; no random row split.",
            "absoluteTimestampsAvailable": False,
            "voyageIdsAvailable": False,
            "trainingObservations": int(len(training)),
            "testObservations": int(len(testing)),
            "metrics": time_metrics,
            "perVessel": per_vessel,
            "timeBlocks": time_blocks,
        },
        "leaveOneVesselOut": {
            "method": "Train on two complete vessels; evaluate on the third, repeated for all vessels.",
            "metrics": oov_metrics,
            "folds": oov_folds,
        },
        "physicsBaseline": {
            "status": "not_comparable",
            "reason": "FuelCast records do not include the per-vessel rated/design power, engine efficiency, or sourced SFOC curves required by the application's physics model. Applying its voyage-level calculation to these sensor rows would require fabricated vessel particulars.",
        },
        "dataLimitations": [
            "The files contain a sequential source index, not absolute timestamps; chronological blocks use retained source order and the supplied five-minute sampling description.",
            "FuelCast does not provide reliable voyage IDs; results are not voyage-level accuracy claims.",
            "Validation covers only these three anonymized vessels and the observed operating conditions in these files.",
            "Rows with missing/non-finite selected features, missing/non-finite target, or negative measured target are excluded; no feature values are imputed.",
        ],
        **metadata,
    }
    return report, deployment_model


def train() -> dict[str, Any]:
    data, metadata = load_dataset()
    report, model = evaluate(data, metadata)
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "features": FEATURES, "target": TARGET}, MODEL_PATH)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def predict(rows: list[dict[str, float]]) -> list[float]:
    if not MODEL_PATH.is_file():
        raise FileNotFoundError("FuelCast model is not trained locally. Run the documented training command first.")
    artifact = joblib.load(MODEL_PATH)
    if artifact.get("features") != FEATURES or artifact.get("target") != TARGET:
        raise ValueError("The local FuelCast model schema does not match this pipeline version.")
    frame = pd.DataFrame(rows, columns=FEATURES)
    values = frame.to_numpy(dtype=float)
    if not np.isfinite(values).all():
        raise ValueError("Prediction features must all be finite numeric values.")
    return [float(max(0.0, value)) for value in artifact["model"].predict(frame)]


def main() -> None:
    parser = argparse.ArgumentParser(description="Locally train and validate the FuelCast fuel-rate model.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("train", help="Validate local Parquet files, evaluate, and train a local model.")
    predict_parser = subparsers.add_parser("predict", help="Predict kg/s for JSON feature rows on stdin.")
    predict_parser.add_argument("--stdin-json", action="store_true", required=True)
    args = parser.parse_args()
    try:
        if args.command == "train":
            print(json.dumps(train(), indent=2))
        else:
            request = json.load(sys.stdin)
            print(json.dumps({"fuelRateKgPerSecond": predict(request["rows"])}))
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
