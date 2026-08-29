import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REGISTRY_TEMPLATE = `version = 1

[source.own]
kind = "owned"
path = "owned"
`;

const LOCK_TEMPLATE = `version = 1
`;

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await access(filePath, constants.F_OK);
  } catch {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  }
}

export async function initializeLibrary(libraryPath: string): Promise<void> {
  const absolute = path.resolve(libraryPath);
  await mkdir(path.join(absolute, "owned"), { recursive: true });
  await mkdir(path.join(absolute, "sources"), { recursive: true });
  await mkdir(path.join(absolute, ".skillmanager", "transactions"), { recursive: true });
  await writeIfMissing(path.join(absolute, "skills.toml"), REGISTRY_TEMPLATE);
  await writeIfMissing(path.join(absolute, "skills.lock"), LOCK_TEMPLATE);
  await writeIfMissing(path.join(absolute, ".gitignore"), "/sources/\n/.skillmanager/\n");

  try {
    await access(path.join(absolute, ".git"), constants.F_OK);
  } catch {
    const result = spawnSync("git", ["init", "-b", "main", absolute], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || "无法初始化 SkillLibrary Git 仓库");
    }
  }
}
