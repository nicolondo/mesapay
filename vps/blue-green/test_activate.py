"""Exercise the real deploy script with isolated files and fake services only.

Run with: python3 -m unittest discover -s vps/blue-green -p 'test_*.py' -v
No service manager, network request, package install or real sudo is executed.
"""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


SOURCE = Path(__file__).with_name("activate.sh")
NEW_SHA = "b" * 40
OLD_SHA = "a" * 40

# All privileged commands are routed through this executable. Unknown commands
# fail instead of falling back to a real service or network tool.
FAKE_COMMAND = r'''
import json
import os
from pathlib import Path
import sys

state_path = Path(os.environ["TEST_STATE"])
events_path = Path(os.environ["TEST_EVENTS"])
root = Path(os.environ["TEST_ROOT"]).resolve()
upstream = Path(os.environ["TEST_UPSTREAM"])
state = json.loads(state_path.read_text())
command = Path(sys.argv[0]).name
args = sys.argv[1:]
if command == "sudo":
    if args and args[0] == "-n":
        args = args[1:]
    command, args = Path(args[0]).name, args[1:]

def record(name):
    with events_path.open("a") as stream:
        stream.write(json.dumps({"name": name, "enabled": state["enabled"],
            "running": state["running"]}) + "\n")

def finish(code=0):
    state_path.write_text(json.dumps(state))
    sys.exit(code)

def local_path(value):
    path = Path(value)
    if root not in path.resolve().parents and path.resolve() != root:
        raise SystemExit("refusing path outside the test directory")
    return path

if command == "systemctl":
    actions = [value for value in args if not value.startswith("-")]
    action, unit = actions[0], actions[1]
    if unit not in ("mesapay@blue.service", "mesapay@green.service"):
        raise SystemExit("unexpected service")
    color = unit.split("@")[1].split(".")[0]
    record(action + ":" + color)
    if action == "is-enabled":
        print("enabled" if color in state["enabled"] else "disabled")
        finish(0 if color in state["enabled"] else 1)
    if action == "restart":
        state["running"] = sorted(set(state["running"]) | {color})
    elif action == "stop":
        state["running"] = [value for value in state["running"] if value != color]
    elif action == "enable":
        if state["fail"] == "enable":
            finish(1)
        state["enabled"] = sorted(set(state["enabled"]) | {color})
    elif action == "disable":
        if state["fail"] == "old-disable" and color == state["old"]:
            finish(1)
        state["enabled"] = [value for value in state["enabled"] if value != color]
    else:
        raise SystemExit("unexpected systemctl action: " + action)
    finish()
elif command == "curl":
    url = args[-1]
    urls = {"http://127.0.0.1:3300/api/health": "blue",
        "http://127.0.0.1:3301/api/health": "green"}
    if url not in urls:
        raise SystemExit("refusing a non-test health request")
    color = urls[url]
    record("health:" + color)
    finish(22 if state["fail"] == "health" or color not in state["running"] else 0)
elif command == "nginx":
    if args == ["-t"]:
        record("nginx:test")
        finish(1 if state["fail"] == "nginx-test" else 0)
    if args == ["-s", "reload"]:
        record("nginx:reload")
        if state["fail"] == "nginx-reload":
            finish(1)
        state["serving"] = "green" if ":3301;" in upstream.read_text() else "blue"
        finish()
    raise SystemExit("unexpected nginx command")
elif command == "tee":
    if args != [str(upstream)]:
        raise SystemExit("refusing a non-test nginx write")
    data = sys.stdin.read()
    color = "green" if ":3301;" in data else "blue"
    record("upstream:" + color)
    local_path(upstream).write_text(data)
    print(data, end="")
    finish()
elif command == "mv":
    # GNU mv -Tf replaces a symlink; os.replace has the same semantics on
    # macOS, whose mv does not support -T.
    if len(args) != 3 or args[0] != "-Tf":
        raise SystemExit("unexpected mv command")
    record("current:replace")
    os.replace(local_path(args[1]), local_path(args[2]))
    finish()
elif command == "sleep":
    record("sleep:" + args[0])
    finish()
elif command == "flock":
    record("lock")
    finish()
elif command == "npx" and args == ["prisma", "migrate", "deploy"]:
    record("migrations")
    finish()
elif command == "journalctl":
    record("journal")
    finish()
raise SystemExit("unexpected external command: " + command + " " + repr(args))
'''


class ActivationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mesapay-activate-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.app = self.root / "app"
        self.shared = self.app / "shared"
        self.shared.mkdir(parents=True)
        (self.shared / "uploads").mkdir()
        (self.shared / ".env.production").write_text("# isolated test, no credentials\n")
        self.release = self.app / "releases" / NEW_SHA
        (self.release / ".next").mkdir(parents=True)
        (self.release / ".next" / "BUILD_ID").write_text("already-built-fixture")
        self.old_release = self.app / "releases" / OLD_SHA
        self.old_release.mkdir()
        self.upstream = self.root / "mesapay-active.conf"
        self.state_path = self.root / "state.json"
        self.events_path = self.root / "events.jsonl"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for command in ("sudo", "systemctl", "nginx", "curl", "npx", "npm",
                        "flock", "sleep", "mv", "tee", "journalctl"):
            executable = self.bin / command
            executable.write_text("#!" + sys.executable + "\n" + FAKE_COMMAND)
            executable.chmod(0o755)
        # Exercise the checked-in script, changing only its filesystem roots.
        script = SOURCE.read_text()
        script, app_count = re.subn(r'^APP_DIR="/opt/mesapay"$',
            'APP_DIR="' + str(self.app) + '"', script, flags=re.MULTILINE)
        script, nginx_count = re.subn(r'^NGINX_UPSTREAM_FILE="/etc/nginx/mesapay-active.conf"$',
            'NGINX_UPSTREAM_FILE="' + str(self.upstream) + '"', script, flags=re.MULTILINE)
        self.assertEqual((app_count, nginx_count), (1, 1))
        self.script = self.root / "activate.sh"
        self.script.write_text(script)

    def run_deploy(self, old="blue", fail="", candidate_enabled=False):
        next_color = "green" if old == "blue" else "blue"
        enabled = ([old] if old else []) + ([next_color] if candidate_enabled else [])
        if old:
            (self.app / "active-color").write_text(old + "\n")
            (self.app / old).symlink_to(self.old_release)
            (self.app / "current").symlink_to(self.old_release)
        old_port = 3301 if old == "green" else 3300
        self.original_upstream = f"# original configuration\nserver 127.0.0.1:{old_port};\n"
        self.upstream.write_text(self.original_upstream)
        self.state_path.write_text(json.dumps({"old": old, "enabled": enabled,
            "running": [old] if old else [], "serving": old, "fail": fail}))
        self.events_path.write_text("")
        result = subprocess.run(["/bin/bash", str(self.script), NEW_SHA],
            cwd=self.root, text=True, capture_output=True, timeout=20,
            env={"PATH": str(self.bin) + os.pathsep + "/usr/bin:/bin",
                "LANG": "C", "LC_ALL": "C", "TMPDIR": str(self.root),
                "TEST_ROOT": str(self.root), "TEST_UPSTREAM": str(self.upstream),
                "TEST_STATE": str(self.state_path), "TEST_EVENTS": str(self.events_path)})
        self.state = json.loads(self.state_path.read_text())
        self.events = [json.loads(line) for line in self.events_path.read_text().splitlines()]
        self.names = [event["name"] for event in self.events]
        self.output = result.stdout + result.stderr
        return result

    def assert_order(self, *names):
        previous = -1
        for name in names:
            self.assertIn(name, self.names, self.output)
            index = self.names.index(name)
            self.assertGreater(index, previous, self.names)
            previous = index

    def assert_old_preserved(self, old="blue"):
        self.assertEqual(self.state["serving"], old)
        self.assertEqual(self.upstream.read_text(), self.original_upstream)
        self.assertEqual((self.app / "active-color").read_text().strip(), old)
        self.assertEqual((self.app / "current").resolve(), self.old_release)
        self.assertIn(old, self.state["enabled"])
        self.assertNotIn("stop:" + old, self.names)
        self.assertNotIn("disable:" + old, self.names)

    def assert_successful_switch(self, old):
        next_color = "green" if old == "blue" else "blue"
        result = self.run_deploy(old=old)
        self.assertEqual(result.returncode, 0, self.output)
        # Simulate reboot: only persistently enabled services restart. The
        # nginx upstream must still have a running service after that reboot.
        self.assertEqual(self.state["enabled"], [next_color], self.output)
        self.assertEqual(self.state["running"], [next_color])
        self.assertEqual(self.state["serving"], next_color)
        self.assertIn(self.state["serving"], self.state["enabled"])
        self.assertEqual((self.app / "active-color").read_text().strip(), next_color)
        self.assertEqual((self.app / "current").resolve(), self.release)
        self.assert_order("migrations", "restart:" + next_color, "health:" + next_color,
            "enable:" + next_color, "upstream:" + next_color, "nginx:test", "nginx:reload",
            "current:replace", "sleep:100", "stop:" + old, "disable:" + old)
        write = next(event for event in self.events if event["name"] == "upstream:" + next_color)
        self.assertIn(next_color, write["enabled"])
        self.assertIn(old, write["running"])

    def test_blue_to_green_survives_reboot(self):
        self.assert_successful_switch("blue")

    def test_green_to_blue_survives_reboot(self):
        self.assert_successful_switch("green")

    def test_failed_health_does_not_enable_or_swap(self):
        result = self.run_deploy(fail="health")
        self.assertNotEqual(result.returncode, 0)
        self.assert_old_preserved()
        self.assertEqual(self.state["enabled"], ["blue"])
        self.assertNotIn("enable:green", self.names)
        self.assertNotIn("upstream:green", self.names)

    def test_failed_enable_keeps_old_traffic_and_boot_service(self):
        result = self.run_deploy(fail="enable")
        self.assertNotEqual(result.returncode, 0, self.output)
        self.assert_order("health:green", "enable:green")
        self.assert_old_preserved()
        self.assertEqual(self.state["enabled"], ["blue"])
        self.assertNotIn("upstream:green", self.names)

    def assert_nginx_failure(self, fail, candidate_enabled=False):
        result = self.run_deploy(fail=fail, candidate_enabled=candidate_enabled)
        self.assertNotEqual(result.returncode, 0, self.output)
        self.assert_old_preserved()
        self.assertIn("enable:green", self.names)
        if candidate_enabled:
            self.assertEqual(sorted(self.state["enabled"]), ["blue", "green"])
            self.assertNotIn("disable:green", self.names)
        else:
            self.assertEqual(self.state["enabled"], ["blue"])
            self.assert_order("enable:green", "upstream:green", "upstream:blue", "disable:green")
        if fail == "nginx-test":
            self.assertNotIn("nginx:reload", self.names)
        else:
            self.assert_order("nginx:test", "nginx:reload", "upstream:blue")

    def test_failed_nginx_validation_restores_config_and_undoes_enable(self):
        self.assert_nginx_failure("nginx-test")

    def test_failed_nginx_reload_restores_config_and_undoes_enable(self):
        self.assert_nginx_failure("nginx-reload")

    def test_nginx_failure_preserves_previously_enabled_candidate(self):
        self.assert_nginx_failure("nginx-test", candidate_enabled=True)

    def test_reload_failure_preserves_previously_enabled_candidate(self):
        self.assert_nginx_failure("nginx-reload", candidate_enabled=True)

    def test_failed_old_disable_keeps_new_service_serving_and_enabled(self):
        result = self.run_deploy(fail="old-disable")
        self.assertNotEqual(result.returncode, 0, self.output)
        self.assertEqual(self.state["serving"], "green")
        self.assertIn("green", self.state["enabled"])
        self.assertEqual(self.state["running"], ["green"])
        self.assertEqual((self.app / "active-color").read_text().strip(), "green")
        self.assertEqual((self.app / "current").resolve(), self.release)
        self.assert_order("nginx:reload", "sleep:100", "stop:blue", "disable:blue")
        self.assertNotIn("disable:green", self.names)

    def test_first_deploy_enables_blue_without_stopping_a_nonexistent_color(self):
        result = self.run_deploy(old="")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual(self.state["enabled"], ["blue"])
        self.assertEqual(self.state["running"], ["blue"])
        self.assertEqual(self.state["serving"], "blue")
        self.assertEqual((self.app / "current").resolve(), self.release)
        self.assert_order("health:blue", "enable:blue", "upstream:blue", "nginx:reload")
        self.assertFalse(any(name.startswith(("stop:", "disable:")) for name in self.names))


if __name__ == "__main__":
    unittest.main()
