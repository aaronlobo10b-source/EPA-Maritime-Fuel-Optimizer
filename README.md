# Maritime Fuel Optimizer

A source-backed vessel and voyage planning tool with a physics-based engineering baseline, fleet-level fuel comparisons, and optional local FuelCast measured-rate predictions.

## Run

- `pnpm install` installs the JavaScript workspace.
- `pnpm run typecheck` typechecks workspace packages.
- `pnpm run build` typechecks and builds the API and dashboard.
- `pnpm --filter @workspace/api-server run dev` starts the API on port 5000.
- `pnpm --filter @workspace/maritime-optimizer run dev` starts the dashboard.

Vessel profiles are operator-entered and require source citations. The application does not preload demo vessels, synthetic training records, fuel prices, or exchange rates.

`DATABASE_URL` is required for persistent vessel profiles and voyage optimization. The health check, maritime catalog, and locally trained FuelCast validation endpoint can run without a database.

### Local PostgreSQL with Docker

For local development, start PostgreSQL and wait for it to accept connections:

```sh
docker run -d --name maritime-postgres \
	-e POSTGRES_USER=maritime \
	-e POSTGRES_PASSWORD=maritime_dev \
	-e POSTGRES_DB=maritime_optimizer \
	-p 5432:5432 \
	-v maritime-postgres-data:/var/lib/postgresql/data \
	--health-cmd='pg_isready -U maritime -d maritime_optimizer' \
	--health-interval=2s --health-timeout=5s --health-retries=10 \
	postgres:16-alpine
docker exec maritime-postgres pg_isready -U maritime -d maritime_optimizer
```

Then configure the API process, apply the schema, and start the API:

```sh
export DATABASE_URL='postgresql://maritime:maritime_dev@127.0.0.1:5432/maritime_optimizer'
pnpm --filter @workspace/db run push
PORT=5000 pnpm --filter @workspace/api-server run dev
```

The `maritime_dev` password is for this local container only; do not reuse it for a shared or production database. Vessel profiles remain empty until you enter source-backed vessel data.

## FuelCast Data and Local Training

FuelCast is the real-world measured-data source used by the optional fuel-rate model:

- Dataset: [FuelCast on Hugging Face](https://huggingface.co/datasets/krohnedigital/FuelCast)
- License: [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/). Review the dataset terms and confirm your intended use is permitted before downloading or training.
- Paper: Viga, J., Mueck, P., Löser, A., and Weis, T. (2026). “FuelCast: Benchmarking Tabular and Temporal Models for Ship Fuel Consumption.” *Advanced Analytics and Learning on Temporal Data*, LNCS 16255, pp. 54–69. [doi:10.1007/978-3-032-15535-1_4](https://doi.org/10.1007/978-3-032-15535-1_4).
- Attribution: cite the paper above and identify the FuelCast dataset and its authors when using or discussing derived results.
- The paper describes Coriolis mass-flow measurement via onboard sensors; the target is `Consumer_Total_MomentaryFuel` in kg/s. The data card describes the KROHNE EcoMATE logger and documents the column units.

The data files and trained weights are not included in this project. To obtain and train locally:

```sh
python3 -m pip install 'huggingface_hub[cli]'
hf download krohnedigital/FuelCast CPS_Poseidon.parquet CPS_Triton.parquet OSS_Ceto.parquet --repo-type dataset --local-dir .local/fuelcast/data
python3 -m pip install -r scripts/requirements-fuelcast.txt
python3 scripts/fuelcast_model.py train
python3 -m unittest scripts.test_fuelcast_model -v
```

Training writes the model and validation report to `.local/fuelcast/`, which is ignored by Git. The raw Parquet files belong in `.local/fuelcast/data/`; do not commit or redistribute the raw data, transformed data, or model weights. The downloads remain subject to the dataset's non-commercial and no-derivatives license conditions.

The selected shared measured features are `Consumer_Total_ShaftPower` (W), `Ship_SpeedOverGround` (m/s), `Weather_WindSpeed10M` (m/s), `Weather_WaveHeight` (m), and `Weather_OceanCurrentVelocity` (m/s). Rows with missing/non-finite selected features or invalid targets are excluded without imputation. No synthetic records are mixed into FuelCast training.

Validation uses the last 20% of each vessel's stored five-minute row sequence as a time block. The files contain a sequential index, not absolute timestamps or reliable voyage IDs. Leave-one-vessel-out validation trains on two vessels and tests on the third. These results do not establish voyage-level accuracy or transfer to all ship types, fuel types, or operating conditions. FuelCast's total measured rate does not identify a single optimizer fuel profile; the ML optimizer therefore requires one operator-priced fuel scenario and does not claim the fuel mapping is validated. The physics baseline cannot be evaluated fairly on FuelCast rows because the files do not provide the sourced vessel particulars and SFOC curves required by that model.

## Private FuelCast artifacts for hosted deployment

The repository does not contain the raw FuelCast Parquet files, transformed data, or trained model weights. For hosted deployment, keep those files in a private bucket or secure storage and let the API download them at runtime from a configured storage endpoint.

Recommended deployment flow:

1. Create a private Supabase Storage bucket such as `fuelcast-private`.
2. Upload only these two artifacts to that bucket:
   - `fuelcast_model.joblib`
   - `validation.json`
3. Set the runtime secrets in Render or your hosting platform:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `FUELCAST_STORAGE_BUCKET=fuelcast-private`
   - `FUELCAST_MODEL_SHA256=<sha256 of the joblib file>`
4. Keep `FUELCAST_ARTIFACT_DIR` on the writable local filesystem (the default is `/tmp/fuelcast` in the Render config).
5. Never commit `.local/fuelcast/`, any downloaded Parquet files, or model artifacts to the repository.

Example checksum step for the local model artifact:

```sh
sha256sum .local/fuelcast/fuelcast_model.joblib
```

The API validates the downloaded model hash before accepting it, and it refuses to run the private model download unless the storage credentials are configured.

## Optimization and Currency

The physics-based model remains the default and retains the existing QPSO, GA, PSO, greedy comparison, constraints, and Pareto analysis. The optional FuelCast model predicts a rate in kg/s; the optimizer converts it to consumed mass as `rate × sailing_seconds ÷ 1000` tonnes. Voyage distance, cargo demand, capacity, schedule, emissions factors, and fuel properties remain separate scenario inputs. Fuel volume is calculated only from an explicitly entered density.

All financial inputs and calculations use INR directly, with no exchange-rate conversion:

- Fuel price: ₹/tonne
- Carbon price: ₹/tonne CO₂e
- Port charges and total voyage cost: ₹/voyage

Prices are operator-entered, dated, and sourced. No Indian marine-fuel market price is presented as current data. The application has no demo price assumption.

## Known Limits

- FuelCast contains three anonymized vessels and has no voyage IDs; held-out-vessel performance is materially weaker than chronological within-vessel performance.
- The local validation report is based on the files available at training time and should be regenerated after any dataset or feature changes.
- FuelCast is not a vessel specification source; onboard engine models, physical constraints, and sourced fuel/emissions assumptions remain operator responsibilities.
- The current optimizer includes QPSO, GA, PSO, and greedy methods. There is no QUBO implementation in the current codebase.
- Physics and environmental corrections are screening estimates, not engineering certification or regulatory compliance calculations.
