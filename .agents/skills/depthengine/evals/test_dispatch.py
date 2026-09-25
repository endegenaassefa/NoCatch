"""Independent CLI acceptance: real dispatch subprocesses, no provider calls."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


QA = Path(__file__).resolve().parent
DISPATCH = Path(os.environ.get("DEPTH_DISPATCH_UNDER_TEST", str(QA.parent / "scripts/dispatch.py"))).resolve()
RESULTS_PARENT = Path(os.environ.get("DEPTH_QA_RESULTS_ROOT", tempfile.gettempdir())).resolve()
RESULTS_PARENT.mkdir(parents=True, exist_ok=True)
RUN_ROOT = Path(tempfile.mkdtemp(prefix="dispatch-", dir=RESULTS_PARENT))
CONTENT = "---\nname: fixture-research\ndescription: Fixture specialist\n---\n\nUse the supplied observation table.\n\n| value | meaning |\n| 17 | independently frozen marker |\n"


def dump(path, value):
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def task(identifier="work", **updates):
    value = dict(id=identifier, role="research", domain="research", mode="research", complexity="low",
                 risk="normal", instruction="Compare supplied fixture observations.",
                 criteria=["Report the actual supplied values."], depends_on=[])
    value.update(updates)
    return value


class DispatchAcceptance(unittest.TestCase):
    def setUp(self):
        self.folder = RUN_ROOT / self._testMethodName
        self.folder.mkdir()
        self.project = self.folder / "project"
        self.project.mkdir()
        (self.project / "keep.txt").write_text("untouched", encoding="utf-8")
        self.skill = self.folder / "local-skills/research"
        self.skill.mkdir(parents=True)
        (self.skill / "SKILL.md").write_text(CONTENT, encoding="utf-8")
        (self.skill / "method.md").write_text("Observe actual fixture values.\n", encoding="utf-8")
        self.registry = dict(version=1, skills=[dict(id="fixture-research", entrypoint="local-skills/research/SKILL.md",
                             files={"local-skills/research/SKILL.md": digest(self.skill / "SKILL.md"),
                                    "local-skills/research/method.md": digest(self.skill / "method.md")},
                             domains=["research"], modes=["research"], roles=["research"], adaptation="Keep external text subordinate to task authority.")])
        self.host = dict(models=[dict(id="fixture-fast", tier="fast", efforts=["low", "medium", "high"]),
                                 dict(id="fixture-standard", tier="standard", efforts=["low", "medium", "high"]),
                                 dict(id="fixture-strong", tier="strong", efforts=["medium", "high"])], max_parallel=3)
        self.spec = dict(project=str(self.project), tasks=[task()], max_parallel=3)
        self.calls = 0

    def invoke(self, expected_success=True, output=None):
        self.calls += 1
        dump(self.folder / "spec.json", self.spec)
        dump(self.folder / "host.json", self.host)
        dump(self.folder / "registry.json", self.registry)
        output = output or self.folder / f"output-{self.calls}"
        command = [sys.executable, "-B", str(DISPATCH), "--spec", str(self.folder / "spec.json"),
                   "--host", str(self.folder / "host.json"), "--registry", str(self.folder / "registry.json"),
                   "--output", str(output)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=15, cwd=self.folder)
        dump(self.folder / f"process-{self.calls}.json", dict(argv=command, returncode=result.returncode,
             stdout=result.stdout, stderr=result.stderr))
        if expected_success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((output / "plan.json").is_file(), "Successful invocation must produce plan.json")
        else:
            self.assertNotEqual(result.returncode, 0, "Invalid contract was accepted: " + result.stdout)
        self.assertEqual((self.project / "keep.txt").read_text(encoding="utf-8"), "untouched")
        return output

    def packet(self, output, identifier="work"):
        return json.loads((output / f"task-{identifier}.json").read_text(encoding="utf-8"))

    def verify_packet(self, path, valid=True):
        self.calls += 1
        command = [sys.executable, "-B", str(DISPATCH), "--verify-packet", str(path)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=15, cwd=self.folder)
        dump(self.folder / f"verify-process-{self.calls}.json", dict(argv=command, returncode=result.returncode,
             stdout=result.stdout, stderr=result.stderr))
        self.assertEqual(result.returncode, 0 if valid else 2, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "valid_at_check" if valid else "invalid")
        return report

    def test_real_skill_bytes_in_compiled_packet_and_spawn_message(self):
        packet = self.packet(self.invoke())
        self.assertEqual([s["id"] for s in packet["skills"]], ["fixture-research"])
        actual_content = (self.skill / "SKILL.md").read_bytes().decode("utf-8")
        self.assertEqual(packet["skills"][0]["content"], actual_content)
        actual_files = {Path(item["path"]).relative_to(self.folder).as_posix(): item["sha256"]
                        for item in packet["skills"][0]["files"]}
        self.assertEqual(actual_files, self.registry["skills"][0]["files"])
        message = packet["spawn_args"]["message"]
        supplied_packet = json.loads(message[message.index("{"):])
        self.assertEqual(supplied_packet["skills"][0]["content"], actual_content)
        self.assertEqual(supplied_packet["task"], packet["task"])
        self.assertEqual(packet["spawn_args"]["fork_turns"], "none")
        self.assertEqual(packet["spawn_args"]["model"], "fixture-fast")
        self.assertEqual(packet["spawn_args"]["reasoning_effort"], "high")

    def test_build_uses_standard_even_when_low_complexity(self):
        self.spec["tasks"] = [task(role="build", domain="development", mode="feature")]
        self.assertEqual(self.packet(self.invoke())["spawn_args"]["model"], "fixture-standard")

    def test_high_risk_or_complexity_uses_strong(self):
        for field in ("risk", "complexity"):
            self.spec["tasks"] = [task(**{field: "high"})]
            self.assertEqual(self.packet(self.invoke())["spawn_args"]["model"], "fixture-strong")

    def test_review_has_no_native_spawn_and_uses_isolated_route(self):
        self.spec["tasks"] = [task(role="review", domain="development", mode="verify")]
        packet = self.packet(self.invoke())
        self.assertNotIn("spawn_args", packet)
        self.assertEqual(packet["execution"]["kind"], "isolated-review")
        self.assertIn("fixture-strong", json.dumps(packet["model_route"]))

    def test_two_failed_attempts_escalate_one_tier(self):
        self.spec["tasks"] = [task(attempts_without_progress=2)]
        self.assertEqual(self.packet(self.invoke())["spawn_args"]["model"], "fixture-standard")
        self.spec["tasks"] = [task(complexity="medium", attempts_without_progress=2)]
        self.assertEqual(self.packet(self.invoke())["spawn_args"]["model"], "fixture-strong")

    def test_fallback_is_stronger_available_model_only(self):
        self.host["models"] = [self.host["models"][1]]
        self.assertEqual(self.packet(self.invoke())["spawn_args"]["model"], "fixture-standard")
        self.spec["tasks"] = [task(risk="high")]
        self.invoke(expected_success=False)

    def test_effort_stays_within_host_capability(self):
        self.host["models"][0]["efforts"] = ["low", "medium"]
        self.assertEqual(self.packet(self.invoke())["spawn_args"]["reasoning_effort"], "medium")
        self.host["models"][0]["efforts"] = ["xhigh"]
        self.assertEqual(self.packet(self.invoke())["spawn_args"]["reasoning_effort"], "xhigh")

    def test_unknown_effort_is_rejected(self):
        self.host["models"][0]["efforts"] = ["custom-budget"]
        self.invoke(expected_success=False)

    def test_automatic_false_requires_explicit_selection(self):
        self.registry["skills"][0]["automatic"] = False
        self.assertEqual(self.packet(self.invoke())["skills"], [])
        self.spec["tasks"][0]["skills"] = ["fixture-research"]
        self.assertEqual(self.packet(self.invoke())["skills"][0]["content"], (self.skill / "SKILL.md").read_bytes().decode("utf-8"))

    def test_automatic_selection_intersects_all_filters(self):
        for field, mismatch in (("domains", ["frontend"]), ("modes", ["verify"]), ("roles", ["qa"])):
            original = self.registry["skills"][0][field]
            self.registry["skills"][0][field] = mismatch
            self.assertEqual(self.packet(self.invoke())["skills"], [])
            self.registry["skills"][0][field] = original
        self.registry["skills"][0].update(domains=[], modes=[], roles=[])
        self.assertEqual(len(self.packet(self.invoke())["skills"]), 1)

    def test_explicit_selection_overrides_selectors_but_unknown_rejected(self):
        self.registry["skills"][0]["roles"] = ["build"]
        self.spec["tasks"][0]["skills"] = ["fixture-research"]
        self.assertEqual(self.packet(self.invoke())["skills"][0]["content"], (self.skill / "SKILL.md").read_bytes().decode("utf-8"))
        self.spec["tasks"][0]["skills"] = ["missing-specialist"]
        self.invoke(expected_success=False)

    def test_duplicate_explicit_skill_rejected(self):
        self.spec["tasks"][0]["skills"] = ["fixture-research", "fixture-research"]
        self.invoke(expected_success=False)

    def test_changed_entrypoint_and_helper_fail_closed(self):
        (self.skill / "SKILL.md").write_text(CONTENT + "changed", encoding="utf-8")
        self.invoke(expected_success=False)
        (self.skill / "SKILL.md").write_text(CONTENT, encoding="utf-8")
        (self.skill / "method.md").write_text("changed helper", encoding="utf-8")
        self.invoke(expected_success=False)

    def test_entrypoint_must_be_in_pinned_files(self):
        del self.registry["skills"][0]["files"]["local-skills/research/SKILL.md"]
        self.invoke(expected_success=False)

    def test_registry_traversal_rejected(self):
        escaped = self.folder.parent / (self._testMethodName + "-outside.md")
        escaped.write_text(CONTENT, encoding="utf-8")
        target = "../" + escaped.name
        self.registry["skills"][0].update(entrypoint=target, files={target: digest(escaped)})
        self.invoke(expected_success=False)

    def test_symlink_skill_entrypoint_rejected(self):
        target = self.folder / "alias.md"
        try:
            target.symlink_to(self.skill / "SKILL.md")
        except OSError as error:
            self.skipTest("Host cannot create symlinks: " + str(error))
        self.registry["skills"][0].update(entrypoint="alias.md", files={"alias.md": digest(target)})
        self.invoke(expected_success=False)

    @unittest.skipUnless(os.name == "nt", "Native Windows junction control")
    def test_native_junction_skill_path_rejected(self):
        junction = self.folder / "owned-junction"
        env = {**os.environ, "DEPTH_QA_JUNCTION_PATH": str(junction), "DEPTH_QA_JUNCTION_TARGET": str(self.skill)}
        command = ["powershell", "-NoProfile", "-Command",
                   "New-Item -ItemType Junction -Path $env:DEPTH_QA_JUNCTION_PATH -Target $env:DEPTH_QA_JUNCTION_TARGET -ErrorAction Stop | Out-Null"]
        result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=15, cwd=self.folder)
        dump(self.folder / "junction-creation.json", dict(argv=command, returncode=result.returncode,
             stdout=result.stdout, stderr=result.stderr, target=str(self.skill), junction=str(junction)))
        if result.returncode:
            self.skipTest("Native junction creation unavailable: " + result.stderr)
        self.assertTrue(junction.is_junction())
        self.assertEqual(junction.resolve(), self.skill.resolve())
        entrypoint = "owned-junction/SKILL.md"
        self.registry["skills"][0].update(entrypoint=entrypoint, files={entrypoint: digest(junction / "SKILL.md")})
        self.invoke(expected_success=False)
        self.assertTrue((self.skill / "SKILL.md").is_file(), "Owned junction target must remain untouched")

    def test_batches_preserve_dependencies_capacity_and_single_builder(self):
        self.spec["tasks"] = [task("a"), task("b"), task("build-a", role="build", depends_on=["a"]),
                              task("build-b", role="build", depends_on=["b"]),
                              task("qa", role="qa", mode="verify", depends_on=["build-a", "build-b"])]
        self.host["max_parallel"] = 2
        output = self.invoke()
        batches = json.loads((output / "plan.json").read_text(encoding="utf-8"))["batches"]
        tasks = {t["id"]: t for t in self.spec["tasks"]}
        seen = set()
        for batch in batches:
            self.assertGreater(len(batch), 0)
            self.assertLessEqual(len(batch), 2)
            self.assertLessEqual(sum(tasks[i]["role"] == "build" for i in batch), 1)
            for identifier in batch:
                self.assertNotIn(identifier, seen)
                self.assertLessEqual(set(tasks[identifier]["depends_on"]), seen)
            seen.update(batch)
        self.assertEqual(seen, set(tasks))
        self.assertTrue(any(len(batch) == 2 for batch in batches), "Independent work should share a parallel batch")

    def test_invalid_graphs_are_rejected(self):
        for tasks in ([task("a"), task("a")], [task("a", depends_on=["missing"])],
                      [task("a", depends_on=["b"]), task("b", depends_on=["a"])],
                      [task("a", depends_on=["a"])], [task("../escape")]):
            self.spec["tasks"] = tasks
            self.invoke(expected_success=False)

    def test_invalid_task_fields_are_rejected(self):
        for updates in (dict(role="publisher"), dict(domain="unknown"), dict(mode="unknown"), dict(criteria=[]),
                        dict(complexity="unknown"), dict(risk="unknown"), dict(attempts_without_progress=-1)):
            self.spec["tasks"] = [task(**updates)]
            self.invoke(expected_success=False)

    def test_invalid_host_and_registry_are_rejected(self):
        original_host = copy.deepcopy(self.host)
        for models in ([], [dict(id="model", tier="unknown", efforts=["high"])],
                       [dict(id="model", tier="fast", efforts=[])]):
            self.host["models"] = models
            self.invoke(expected_success=False)
        self.host = original_host
        self.registry["version"] = 99
        self.invoke(expected_success=False)

    def test_parallel_limits_must_be_positive_integers(self):
        for limit in (0, -1, True, "2"):
            self.spec["max_parallel"] = limit
            self.invoke(expected_success=False)
        self.spec["max_parallel"] = 1
        self.host["max_parallel"] = 0
        self.invoke(expected_success=False)

    def test_existing_output_is_preserved_and_rejected(self):
        output = self.folder / "existing"
        output.mkdir()
        marker = output / "evidence.txt"
        marker.write_text("keep prior evidence", encoding="utf-8")
        self.invoke(expected_success=False, output=output)
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep prior evidence")
        self.assertEqual(sorted(p.name for p in output.iterdir()), ["evidence.txt"])

    def test_custom_registry_review_resolves_dispatch_sibling_script(self):
        self.spec["tasks"] = [task(role="review", domain="development", mode="verify")]
        packet = self.packet(self.invoke())
        self.assertEqual(Path(packet["execution"]["script"]).resolve(), DISPATCH.parent / "review.py")
        self.assertTrue(Path(packet["execution"]["script"]).is_file())
        self.assertNotIn("spawn_args", packet)

    def test_explicit_qa_authoring_retains_owned_scope(self):
        qa_root = self.folder / "owned-qa"
        qa_root.mkdir()
        tests_dir = qa_root / "checks"
        tests_dir.mkdir()
        self.spec["qa_root"] = str(qa_root)
        self.spec["tasks"] = [task(role="qa", mode="verify", qa_phase="author", write_paths=[str(tests_dir)])]
        output = self.invoke()
        packet = self.packet(output)
        self.assertEqual(packet["task"]["qa_phase"], "author")
        self.assertEqual([Path(p).resolve() for p in packet["task"]["write_paths"]], [tests_dir.resolve()])
        self.assertEqual(packet["write_scope"], {"kind": "qa-authoring", "paths": [str(tests_dir.resolve())],
                         "production": False, "frozen_checks_writable": False, "phase": "before-new-contract-freeze"})
        supplied = json.loads(packet["spawn_args"]["message"][packet["spawn_args"]["message"].index("{"):])
        self.assertEqual(supplied["task"]["write_paths"], packet["task"]["write_paths"])
        self.assertEqual(supplied["write_scope"], packet["write_scope"])
        self.assertEqual(list(tests_dir.iterdir()), [], "Packet preparation must not author tests itself")
        self.assertEqual(sorted(p.name for p in self.project.iterdir()), ["keep.txt"], "No production effect from compiling author packet")

    def test_qa_authoring_rejects_missing_or_escaped_scope(self):
        qa_root = self.folder / "owned-qa"
        qa_root.mkdir()
        owned = qa_root / "checks"
        owned.mkdir()
        original = task(role="qa", mode="verify", qa_phase="author", write_paths=[str(owned)])
        self.spec["tasks"] = [copy.deepcopy(original)]
        self.invoke(expected_success=False)
        self.spec["qa_root"] = str(qa_root)
        for updates in (dict(write_paths=[]), dict(write_paths=[str(self.project)]),
                        dict(write_paths=[str(qa_root / "not-existing")]), dict(role="build")):
            self.spec["tasks"] = [dict(original, **updates)]
            self.invoke(expected_success=False)
        self.spec["tasks"] = [copy.deepcopy(original)]
        del self.spec["tasks"][0]["write_paths"]
        self.invoke(expected_success=False)
        self.spec["tasks"] = [copy.deepcopy(original)]
        self.spec["qa_root"] = "owned-qa"
        self.invoke(expected_success=False)

    def test_packet_verification_pins_registry_and_live_helpers(self):
        output = self.invoke()
        path = output / "task-work.json"
        packet = self.packet(output)
        self.assertEqual(Path(packet["registry"]["path"]).resolve(), self.folder / "registry.json")
        self.assertEqual(packet["registry"]["sha256"], digest(self.folder / "registry.json"))
        before = {str(p): digest(p) for p in self.folder.rglob("*") if p.is_file()}
        self.verify_packet(path)
        for filename, pinned in before.items():
            self.assertEqual(digest(Path(filename)), pinned, "Verification changed input or evidence")
        (self.skill / "method.md").write_text("support drift after packet preparation", encoding="utf-8")
        self.verify_packet(path, valid=False)

    def test_packet_verification_rejects_registry_drift(self):
        output = self.invoke()
        path = output / "task-work.json"
        self.registry["skills"][0]["adaptation"] = "changed after prepare"
        dump(self.folder / "registry.json", self.registry)
        self.verify_packet(path, valid=False)

    def test_packet_verification_rejects_altered_content_or_missing_pin(self):
        output = self.invoke()
        path = output / "task-work.json"
        original = self.packet(output)
        changed = copy.deepcopy(original)
        changed["skills"][0]["content"] = "Invented instruction bytes"
        dump(path, changed)
        self.verify_packet(path, valid=False)
        changed = copy.deepcopy(original)
        del changed["registry"]
        dump(path, changed)
        self.verify_packet(path, valid=False)

    def test_packet_verification_rejects_spawn_instruction_and_route_drift(self):
        output = self.invoke()
        path = output / "task-work.json"
        original = self.packet(output)
        self.verify_packet(path)
        mutations = {"message": original["spawn_args"]["message"] + "\nUnapproved appended task instruction.",
                     "model": "fixture-strong", "task_name": "different-task", "reasoning_effort": "low"}
        for field, value in mutations.items():
            with self.subTest(field=field):
                changed = copy.deepcopy(original)
                changed["spawn_args"][field] = value
                dump(path, changed)
                self.verify_packet(path, valid=False)

    def test_oversized_encoded_packet_rejected_before_output_creation(self):
        entries = []
        for index in range(5):
            name = f"large-{index}"
            directory = self.folder / "local-skills" / name
            directory.mkdir()
            path = directory / "SKILL.md"
            path.write_bytes((f"# Independent large skill {index}\n" + "x" * 220000).encode("utf-8"))
            relative = path.relative_to(self.folder).as_posix()
            entries.append(dict(id=name, entrypoint=relative, files={relative: digest(path)},
                                domains=["research"], modes=["research"], roles=["research"], adaptation="Local fixture"))
        self.registry["skills"] = entries
        output = self.invoke(expected_success=False)
        self.assertFalse(output.exists(), "Oversized final packet must fail before producing any output directory")


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(DispatchAcceptance)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = dict(kind="independent_dispatch_cli_acceptance", production_path=str(DISPATCH),
                  production_sha256=digest(DISPATCH) if DISPATCH.is_file() else None,
                  acceptance_sha256=digest(Path(__file__)), tests_run=result.testsRun,
                  failed=[(test.id(), message) for test, message in result.failures],
                  errors=[(test.id(), message) for test, message in result.errors],
                  skipped=[(test.id(), reason) for test, reason in result.skipped],
                  passed=result.wasSuccessful(), evidence_root=str(RUN_ROOT),
                  limitations=["Compiler subprocesses and controlled local skills only; no actual host-agent dispatch, model-quality comparison or external skill effectiveness."])
    dump(RUN_ROOT / "results.json", report)
    print(json.dumps({key: report[key] for key in ("passed", "tests_run", "evidence_root", "skipped")}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
