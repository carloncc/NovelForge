import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("stable_style_server.py")
SPEC = importlib.util.spec_from_file_location("stable_style_server", MODULE_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class StableStyleHealthTests(unittest.TestCase):
    def tearDown(self):
        SERVER.PIPE["value"] = None

    def test_health_distinguishes_reference_initialization_states(self):
        SERVER.PIPE["value"] = None
        self.assertEqual(SERVER.health_payload()["referenceImageStatus"], "uninitialized")

        SERVER.PIPE["value"] = {"reference_image_ready": True, "reference_image_error": None}
        ready = SERVER.health_payload()
        self.assertEqual(ready["referenceImageStatus"], "ready")
        self.assertTrue(ready["referenceImageReady"])

        SERVER.PIPE["value"] = {"reference_image_ready": False, "reference_image_error": "load failed"}
        failed = SERVER.health_payload()
        self.assertEqual(failed["referenceImageStatus"], "failed")
        self.assertFalse(failed["referenceImageReady"])
        self.assertEqual(failed["referenceImageError"], "load failed")


if __name__ == "__main__":
    unittest.main()
