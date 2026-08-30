import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertInside(parent: string, child: string, label: string, allowRoot = false): void {
  if (!isInside(parent, child) || (!allowRoot && path.resolve(parent) === path.resolve(child))) {
    throw new Error(`${label} 逃出了允许的目录`);
  }
}

export function assertSafeSegment(value: string, label: string): void {
  if (
    !value
    || value === "."
    || value === ".."
    || value.includes("\0")
    || value.includes("/")
    || value.includes("\\")
    || path.basename(value) !== value
  ) {
    throw new Error(`${label} 名称必须是安全的单层路径名称`);
  }
}

export function childPath(parent: string, name: string, label: string): string {
  assertSafeSegment(name, label);
  const child = path.resolve(parent, name);
  assertInside(parent, child, label);
  return child;
}

export async function atomicWriteFile(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

const MIGRATION_ID = /^migration-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/i;

export function assertMigrationTransactionId(transactionId: string): void {
  if (!MIGRATION_ID.test(transactionId)) throw new Error("迁移事务 ID 格式无效");
}
