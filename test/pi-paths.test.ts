import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  displayHomePath,
  getGlobalSettingsLabel,
  getProjectSettingsLabel,
} from "../src/utils/pi-paths.js";

void test("settings labels follow PI_CODING_AGENT_DIR instead of assuming ~/.pi/agent", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(homedir(), "custom-agent");
    assert.equal(getGlobalSettingsLabel(), "~/custom-agent/settings.json");
    process.env.PI_CODING_AGENT_DIR = "/opt/pi-agent";
    assert.equal(getGlobalSettingsLabel(), "/opt/pi-agent/settings.json");
    assert.equal(getProjectSettingsLabel(), ".pi/settings.json");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

void test("displayHomePath only abbreviates the home directory itself", () => {
  assert.equal(displayHomePath(homedir()), "~");
  assert.equal(displayHomePath(`${homedir()}-other/file`), `${homedir()}-other/file`);
});
