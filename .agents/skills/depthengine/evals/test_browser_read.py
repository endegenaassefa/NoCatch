"""Independent OpenCLI wrapper tests via real Node subprocess fixtures."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

QA = Path(__file__).resolve().parent
SCRIPT = Path(os.environ.get("DEPTH_BROWSER_READ_UNDER_TEST", str(QA.parent / "scripts/browser_read.py"))).resolve()
RESULTS_PARENT = Path(os.environ.get("DEPTH_QA_RESULTS_ROOT", tempfile.gettempdir())).resolve()
RESULTS_PARENT.mkdir(parents=True, exist_ok=True)
RUN_ROOT = Path(tempfile.mkdtemp(prefix="browser-read-", dir=RESULTS_PARENT))
SECRET = "PRIVATE_PROFILE_QA_SENTINEL"
BODY = b"# Local adapter fixture\nObserved value: 17\n"
DOCTOR = """export async function runBrowserDoctor() {
 if (process.env.QA_DOCTOR_MODE === 'fail') throw new Error('PRIVATE_PROFILE_QA_SENTINEL');
 return {daemonRunning:true, extensionConnected:process.env.QA_DOCTOR_MODE !== 'unhealthy',
 connectivity:{ok:true}, daemonFlaky:false, extensionFlaky:false, daemonStale:false,
 issues:[{profileId:'PRIVATE_PROFILE_QA_SENTINEL'}], profiles:['PRIVATE_PROFILE_QA_SENTINEL']};
}
"""
MAIN = """import fs from 'node:fs';
const args=process.argv.slice(2);
fs.appendFileSync(process.env.QA_ADAPTER_EVENTS, JSON.stringify({argv:args,cwd:process.cwd(),pid:process.pid})+'\\n');
const mode=process.env.QA_READ_MODE;
if(mode==='fail'){process.stderr.write('PRIVATE_PROFILE_QA_SENTINEL');process.exitCode=7;}
else if(mode==='empty'){}
else if(mode==='invalid_utf8'){process.stdout.write(Buffer.from([255,254,253]));}
else if(mode==='oversize'){process.stdout.write(Buffer.alloc(10000001,65));}
else if(mode==='timeout'){await new Promise(resolve=>setTimeout(resolve,8000));}
else {
 const folder=args[args.indexOf('--output')+1]; fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(folder+'/adapter-artifact.txt','written inside scoped output');
 process.stdout.write('# Local adapter fixture\\nObserved value: 17\\n');
}
"""


def dump(path, value):
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@unittest.skipUnless(shutil.which("node"), "Node unavailable; real subprocess adapter fixture cannot run")
class BrowserReadAcceptance(unittest.TestCase):
    def setUp(self):
        self.folder = RUN_ROOT / self._testMethodName
        self.folder.mkdir()
        self.package = self.folder / "upstream-fixture"
        entry = self.package / "dist/src"
        entry.mkdir(parents=True)
        dump(self.package / "package.json", {"name": "@jackwener/opencli", "version": "1.8.8", "type": "module"})
        (entry / "doctor.js").write_text(DOCTOR, encoding="utf-8")
        (entry / "main.js").write_text(MAIN, encoding="utf-8")
        self.events = self.folder / "adapter-events.jsonl"
        self.env = {**os.environ, "QA_ADAPTER_EVENTS": str(self.events)}
        self.calls = 0

    def invoke(self, args, expected_code=0, use_fixture=True):
        self.calls += 1
        command = [sys.executable, "-B", str(SCRIPT)]
        if use_fixture:
            command += ["--package", str(self.package)]
        command += args
        result = subprocess.run(command, capture_output=True, text=True, cwd=self.folder, env=self.env, timeout=40)
        dump(self.folder / f"process-{self.calls}.json", dict(argv=command, returncode=result.returncode,
             stdout=result.stdout, stderr=result.stderr))
        if expected_code is not None:
            self.assertEqual(result.returncode, expected_code, result.stdout + result.stderr)
        self.assertNotIn(SECRET, result.stdout + result.stderr, "Sensitive upstream diagnostics escaped wrapper")
        report = json.loads(result.stdout)
        return report

    def read(self, mode="ok", timeout=60, expected_code=0, url="https://example.org/fixture", output=None):
        self.env["QA_READ_MODE"] = mode
        output = output or self.folder / f"evidence-{self.calls + 1}"
        report = self.invoke(["read", "--url", url, "--output", str(output), "--timeout", str(timeout)], expected_code)
        return report, output

    def test_fixture_doctor_exposes_only_sanitized_health(self):
        report = self.invoke(["doctor"])
        self.assertEqual(report["status"], "ready")
        self.assertEqual(report["issue_count"], 1)
        self.assertTrue(report["live_probe"])
        self.assertNotIn("profiles", report)
        self.assertNotIn("profileId", json.dumps(report))
        self.assertFalse(self.events.exists(), "Doctor must not invoke web read")

    def test_actual_installed_doctor_reports_observed_status(self):
        report = self.invoke(["doctor"], expected_code=None, use_fixture=False)
        self.assertIn(report["status"], ("ready", "unavailable"))
        self.assertNotIn("profiles", report)
        self.assertNotIn("profileId", json.dumps(report))
        if report["status"] == "ready":
            for field in ("daemon_running", "bridge_connected", "live_probe", "stable"):
                self.assertIs(report[field], True)
        dump(self.folder / "observed-installed-status.json", report)

    def test_success_preserves_bytes_hash_and_scoped_invocation(self):
        report, output = self.read()
        self.assertEqual(report["status"], "retrieved")
        self.assertIs(report["retrieved"], True)
        self.assertEqual((output / "content.md").read_bytes(), BODY)
        self.assertEqual(report["sha256"], hashlib.sha256(BODY).hexdigest())
        self.assertEqual(report["bytes"], len(BODY))
        self.assertEqual(json.loads((output / "retrieval.json").read_text(encoding="utf-8")), report)
        events = [json.loads(line) for line in self.events.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(events), 1, "Wrapper should make one retrieval attempt")
        self.assertEqual(Path(events[0]["cwd"]), output)
        args = events[0]["argv"]
        self.assertEqual(args[:2], ["web", "read"])
        for flag, value in (("--url", "https://example.org/fixture"), ("--window", "background"),
                            ("--site-session", "ephemeral"), ("--keep-tab", "false"),
                            ("--download-images", "false")):
            self.assertEqual(args[args.index(flag) + 1], value)
        self.assertTrue((output / "articles/adapter-artifact.txt").is_file())
        self.assertFalse((self.folder / "web-articles").exists())

    def test_failed_empty_invalid_and_oversize_outputs_never_succeed(self):
        for mode in ("fail", "empty", "invalid_utf8", "oversize"):
            report, output = self.read(mode=mode, expected_code=1)
            self.assertEqual(report["status"], "failed")
            self.assertIs(report["retrieved"], False)
            self.assertFalse((output / "content.md").exists())
            self.assertTrue((output / "retrieval.json").is_file())
        self.assertEqual(len(self.events.read_text(encoding="utf-8").splitlines()), 4)

    def test_timeout_is_visible_with_unverified_cleanup(self):
        report, output = self.read(mode="timeout", timeout=5, expected_code=1)
        self.assertEqual(report["status"], "timeout")
        self.assertIs(report["retrieved"], False)
        self.assertIs(report["cleanup_verified"], False)
        self.assertFalse((output / "content.md").exists())
        self.assertEqual(len(self.events.read_text(encoding="utf-8").splitlines()), 1)

    def test_unhealthy_bridge_does_not_read_or_create_evidence(self):
        self.env["QA_DOCTOR_MODE"] = "unhealthy"
        report, output = self.read(expected_code=1)
        self.assertEqual(report["status"], "unavailable")
        self.assertIs(report["retrieved"], False)
        self.assertFalse(self.events.exists())
        self.assertFalse(output.exists())

    def test_doctor_failure_hides_raw_profile_diagnostics(self):
        self.env["QA_DOCTOR_MODE"] = "fail"
        report = self.invoke(["doctor"], expected_code=1)
        self.assertEqual(report["status"], "unavailable")

    def test_existing_output_rejected_without_overwrite(self):
        output = self.folder / "existing"
        output.mkdir()
        (output / "retain.txt").write_text("prior evidence", encoding="utf-8")
        report, _ = self.read(output=output, expected_code=2)
        self.assertEqual(report["status"], "invalid")
        self.assertEqual((output / "retain.txt").read_text(encoding="utf-8"), "prior evidence")
        self.assertEqual(sorted(p.name for p in output.iterdir()), ["retain.txt"])
        self.assertFalse(self.events.exists())

    def test_embedded_credentials_and_non_http_urls_rejected(self):
        for url in ("https://user:password@example.org/a", "https://user@example.org", "file:///C:/secret", "javascript:alert(1)"):
            report, output = self.read(url=url, expected_code=2)
            self.assertEqual(report["status"], "invalid")
            self.assertFalse(output.exists())
        self.assertFalse(self.events.exists())

    def test_out_of_range_timeout_rejected_before_retrieval(self):
        for timeout in (0, 4, 121, -1):
            report, output = self.read(timeout=timeout, expected_code=2)
            self.assertEqual(report["status"], "invalid")
            self.assertFalse(output.exists())
        self.assertFalse(self.events.exists())

    def test_wrong_version_or_missing_entrypoints_fail_closed(self):
        dump(self.package / "package.json", {"name": "@jackwener/opencli", "version": "0.0.0", "type": "module"})
        self.assertEqual(self.invoke(["doctor"], expected_code=1)["status"], "unavailable")
        dump(self.package / "package.json", {"name": "@jackwener/opencli", "version": "1.8.8", "type": "module"})
        # Only an owned single fixture file is removed; preserve all prior logs.
        (self.package / "dist/src/main.js").unlink()
        self.assertEqual(self.invoke(["doctor"], expected_code=1)["status"], "unavailable")
        self.assertFalse(self.events.exists())

    def test_non_object_package_metadata_is_structured_unavailable(self):
        for metadata in ([], None):
            dump(self.package / "package.json", metadata)
            report = self.invoke(["doctor"], expected_code=1)
            self.assertEqual(report["status"], "unavailable")
        self.assertFalse(self.events.exists())


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(BrowserReadAcceptance))
    report = dict(kind="independent_browser_read_cli_acceptance", production_path=str(SCRIPT),
                  production_sha256=digest(SCRIPT), acceptance_sha256=digest(Path(__file__)), tests_run=result.testsRun,
                  failed=[(t.id(), message) for t, message in result.failures], errors=[(t.id(), message) for t, message in result.errors],
                  skipped=[(t.id(), message) for t, message in result.skipped], passed=result.wasSuccessful(), evidence_root=str(RUN_ROOT),
                  limitations=["Adapter success/failure/timeout are real Node subprocess fixtures, not live OpenCLI retrieval.",
                               "Installed doctor observes bridge health only; website login, rendered interaction and browser teardown remain separate."])
    dump(RUN_ROOT / "results.json", report)
    print(json.dumps({k: report[k] for k in ("passed", "tests_run", "evidence_root", "skipped")}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
