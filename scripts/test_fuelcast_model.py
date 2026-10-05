import json
import math
import unittest

from scripts.fuelcast_model import (
    DATA_DIR,
    FEATURES,
    MODEL_PATH,
    REPORT_PATH,
    TARGET,
    load_dataset,
    predict,
)


class FuelCastPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATA_DIR.is_dir():
            raise unittest.SkipTest("FuelCast is licensed data and is not bundled; configure FUELCAST_DATA_DIR.")
        cls.data, cls.metadata = load_dataset()

    def test_real_vessel_files_and_measured_target_are_validated(self) -> None:
        self.assertEqual(self.metadata["observationsLoaded"], 173986)
        self.assertEqual(self.metadata["vesselCount"], 3)
        self.assertEqual(set(self.metadata["vessels"]), {"CPS Triton", "CPS Poseidon", "OSS Ceto"})
        self.assertTrue((self.data[TARGET] >= 0).all())
        self.assertTrue(self.data[FEATURES].notna().all().all())

    def test_trained_model_predicts_from_an_observed_feature_row(self) -> None:
        if not MODEL_PATH.is_file():
            self.skipTest("Run python3 scripts/fuelcast_model.py train to create the local model.")
        row = self.data.iloc[0][FEATURES].to_dict()
        value = predict([row])[0]
        self.assertTrue(math.isfinite(value))
        self.assertGreaterEqual(value, 0)

    def test_validation_report_counts_match_loaded_observations(self) -> None:
        if not REPORT_PATH.is_file():
            self.skipTest("Run python3 scripts/fuelcast_model.py train to create validation results.")
        with REPORT_PATH.open(encoding="utf-8") as report_file:
            report = json.load(report_file)
        self.assertEqual(report["observationsLoaded"], self.metadata["observationsLoaded"])
        self.assertEqual(
            report["validation"]["trainingObservations"] + report["validation"]["testObservations"],
            report["observationsUsable"],
        )


if __name__ == "__main__":
    unittest.main()
