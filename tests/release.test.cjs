const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");
const version = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8")).version;

function stepScript(name) {
  const step = workflow.split(`- name: ${name}\n`)[1];
  assert.ok(step, `Missing release step: ${name}`);
  const script = step.split("run: |\n")[1].split(/\n      - /)[0];
  return script.replace(/^          /gm, "");
}

function run(script, tag) {
  const result = spawnSync("bash", ["-c", script], {
    cwd: root,
    env: { ...process.env, RELEASE_TAG: tag, TEST_VERSION: version, RUNNER_TEMP: "/unused-release-test" },
    encoding: "utf8",
  });
  assert.ifError(result.error);
  return result;
}

test("release tags match the manifest and an optional positive candidate number", () => {
  const script = 'jq() { printf "%s\\n" "$TEST_VERSION"; }\n' +
    stepScript("Verify version and prepare downloads").split("cd dist/release")[0];
  for (const tag of [`v${version}`, `v${version}-rc.1`, `v${version}-rc.12`]) {
    const result = run(script, tag);
    assert.equal(result.status, 0, `${tag}: ${result.stderr}`);
  }
  for (const tag of ["v999.0.0", `v${version}-rc.0`, `v${version}-rc.01`, `v${version}-rc.`,
    `v${version}-rc.bad`, `v${version}-rc.1-extra`, `v${version}-rc.bad-rc.1`]) {
    assert.equal(run(script, tag).status, 1, tag);
  }
});

test("candidate releases cannot replace the latest stable release", () => {
  const script = 'gh() { printf "%s\\n" "$@"; }\n' + stepScript("Publish verified assets");
  for (const candidate of [false, true]) {
    const tag = `v${version}${candidate ? "-rc.1" : ""}`;
    const result = run(script, tag);
    assert.equal(result.status, 0, result.stderr);
    const args = result.stdout.trim().split(/\r?\n/);
    assert.deepEqual(args.slice(0, 3), ["release", "create", tag]);
    assert.ok(args.includes("--verify-tag"));
    assert.equal(args.includes("--prerelease"), candidate);
    assert.equal(args.includes("--latest=false"), candidate);
  }
});
