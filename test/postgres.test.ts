import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "@prisma/orm-postgres/config";
import { executeContractEmit } from "@prisma/orm-toolchain/cli/control-api";
import { zPlainDateTime } from "temporal-zod";
import { z } from "zod";
import {
	createZodExtension,
	defineZodSchema,
} from "../src/exports/column-types";
import { Profile } from "./fixtures/schemas";

const { ZOD_TEST_DATABASE_URL: databaseUrl } = process.env;

// Opt in explicitly; creates and drops only a unique schema in the selected database.
it.skipIf(!databaseUrl)(
	"round-trips DSL contracts through PostgreSQL",
	async () => {
		const url = databaseUrl;
		if (!url) throw new Error("Set ZOD_TEST_DATABASE_URL to run this test");
		const schema = `zod_test_${randomUUID().replaceAll("-", "")}`;
		const directory = await mkdtemp(join(process.cwd(), ".zod-emit-"));
		const sql = (query: string) =>
			execFileSync(
				"psql",
				[url, "-X", "-v", "ON_ERROR_STOP=1", "-Atc", query],
				{ encoding: "utf8" },
			).trim();
		const extension = createZodExtension(
			{
				Profile: defineZodSchema(Profile),
				DateTime: defineZodSchema(zPlainDateTime),
				Date: defineZodSchema(z.date()),
				Data: defineZodSchema(
					z.object({
						createdAt: z.date(),
						unknown: z.unknown(),
						missing: z.string().optional(),
					}),
				),
			},
			{ module: "./schemas", export: "SchemaTypes" },
		);
		let created = false;
		try {
			await writeFile(
				join(directory, "contract.prisma"),
				`// use prisma-8
types {
  ProfileJson = zod.Json("Profile")
}
namespace ${schema} {
  model User {
    id String @id
    profile zod.Json("Profile")
    optional ProfileJson?
    data zod.Json("Data")?
    dateTime zod.Json("DateTime")?
    date zod.Json("Date")?
    @@map("users")
  }
}
`,
			);
			const result = await executeContractEmit({
				config: defineConfig({
					contract: join(directory, "contract.prisma"),
					extensions: [extension.control],
				}),
				cwd: process.cwd(),
			});
			const contract = JSON.parse(await readFile(result.files.json, "utf8"));
			expect(
				contract.storage.namespaces[schema].entries.table.users.columns.profile
					.dataType,
			).toBe("pg/jsonb");
			sql(
				`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".users (id text PRIMARY KEY, profile jsonb NOT NULL, optional jsonb, data jsonb, "dateTime" jsonb, date jsonb);`,
			);
			created = true;
			await writeFile(
				join(directory, "run.mjs"),
				`
import assert from "node:assert/strict";
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { z } from "zod";
import { createZodExtension, defineZodSchema } from "../dist/column-types.mjs";
const zData = z.object({ createdAt: z.date(), unknown: z.unknown(), missing: z.string().optional() });
import { PlainDateTime, zPlainDateTime } from "temporal-zod";
import contractJson from "./contract.json" with { type: "json" };
const extension = createZodExtension({ Profile: defineZodSchema(z.object({ name: z.string(), age: z.string().transform(Number) })), Data: defineZodSchema(zData), DateTime: defineZodSchema(zPlainDateTime), Date: defineZodSchema(z.date()) }, { module: "./schemas", export: "SchemaTypes" });
const db = postgres({ contract: contractFromJson(contractJson), url: process.env.ZOD_TEST_DATABASE_URL, extensions: [extension.runtime], verifyMarker: false });
try {
  const users = db.orm[${JSON.stringify(schema)}].User;
  await users.create({ id: "one", profile: { name: "Ada", age: "36" }, optional: null, data: null, dateTime: null, date: null });
  assert.deepEqual(await users.where({ id: "one" }).first(), { id: "one", profile: { name: "Ada", age: 36 }, optional: null, data: null, dateTime: null, date: null });
  await users.create({ id: "two", profile: { name: "Grace", age: "40" }, optional: { name: "Ada", age: "36" } });
  assert.deepEqual((await users.where({ id: "two" }).first()).optional, { name: "Ada", age: 36 });
  const createdAt = new Date("2026-09-12T00:00:00.123Z");
  const data = { createdAt, unknown: { date: createdAt, values: [undefined, NaN] }, missing: undefined };
  const dateTime = PlainDateTime.from("2026-09-12T13:45:30.123456789");
  await users.create({ id: "data", profile: { name: "Data", age: "1" }, data, dateTime, date: createdAt });
  const row = await users.where({ id: "data" }).first();
  assert.deepEqual(row.data, { createdAt, unknown: { date: createdAt.toISOString(), values: [null, null] } });
  assert.equal(row.dateTime.toString(), dateTime.toString());
  assert.ok(row.date instanceof Date);
  assert.equal(row.date.getTime(), createdAt.getTime());
  await users.where({ id: "data" }).update({ data, dateTime, date: createdAt });
  assert.deepEqual((await users.where({ id: "data" }).first()).data, row.data);
  await assert.rejects(async () => users.create({ id: "invalid", profile: { name: "Bad", age: 42 }, optional: null }));
} finally { await db.close(); }
`,
			);
			execFileSync(process.execPath, [join(directory, "run.mjs")], {
				encoding: "utf8",
				env: process.env,
			});
			expect(
				sql(
					`SELECT profile->>'age' || ':' || jsonb_typeof(profile->'age') FROM "${schema}".users WHERE id = 'one'`,
				),
			).toBe("36:string");
			expect(
				sql(
					`SELECT data->>'createdAt' || ':' || jsonb_typeof(data->'createdAt') || ':' || (data ? 'missing')::text FROM "${schema}".users WHERE id = 'data'`,
				),
			).toBe("2026-09-12T00:00:00.123Z:string:false");
			expect(
				sql(
					`SELECT date = to_jsonb('2026-09-12T00:00:00.123Z'::text) AND "dateTime" = to_jsonb('2026-09-12T13:45:30.123456789'::text) FROM "${schema}".users WHERE id = 'data'`,
				),
			).toBe("t");
			expect(sql(`SELECT count(*) FROM "${schema}".users`)).toBe("3");
		} finally {
			if (created) sql(`DROP SCHEMA "${schema}" CASCADE`);
			await rm(directory, { recursive: true, force: true });
		}
	},
	30_000,
);
