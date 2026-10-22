import { pgJsonb } from "@prisma/orm-postgres/target/data-types";
import { Temporal } from "ponyfill-temporal";
import { z } from "zod";
import * as mini from "zod/mini";
import {
	createZodExtension,
	defineZodSchema,
} from "../src/exports/column-types";

function codecFor(schema: z.core.$ZodType) {
	const extension = createZodExtension(
		{ value: defineZodSchema(schema) },
		{ module: "./schemas", export: "Types" },
	);
	return extension.descriptor.factory(extension.column("value").typeParams)();
}
const iso = "2026-09-12T00:00:00.000Z";
const date = new Date(iso);

it("delegates native storage unchanged and never guesses types in unknown data", async () => {
	const value = {
		date,
		missing: undefined,
		values: [undefined, NaN, Infinity, -0],
		map: new Map([["a", 1]]),
		set: new Set([1]),
		marker: { $prismaZod: "devalue@1", value: ["unchanged"] },
	};
	const codec = codecFor(z.unknown());
	expect(codec.toDataTypeValue(value).value).toBe(value);
	expect(await codec.toWire(value)).toBe(JSON.stringify(value));
	expect(
		await codec.fromWire(JSON.parse(await codec.toWire(value))),
	).toStrictEqual(JSON.parse(JSON.stringify(value)));
	const cycle: Record<string, unknown> = {};
	// biome-ignore lint/complexity/useLiteralKeys: index signature
	cycle["self"] = cycle;
	await expect(codec.toWire(cycle)).rejects.toThrow();
	await expect(codec.toWire(1n)).rejects.toThrow();
});

it("hydrates nested schemas while preserving absent keys, null and unknown strings", async () => {
	const schema = z
		.object({
			date: z.date(),
			optional: z.date().optional(),
			nullable: z.date().nullable(),
			list: z.array(z.date()),
			tuple: z.tuple([z.date()]).rest(z.date()),
			record: z.record(z.string(), z.date()),
			any: z.any(),
			unknown: z.unknown(),
		})
		.catchall(z.date());
	const stored = {
		date: iso,
		nullable: null,
		list: [iso],
		tuple: [iso, iso],
		record: { a: iso },
		any: iso,
		unknown: { date: iso },
		extra: iso,
	};
	const expected = {
		...stored,
		date,
		list: [date],
		tuple: [date, date],
		record: { a: date },
		extra: date,
	};
	const codec = codecFor(schema);
	expect(await codec.fromWire(stored)).toStrictEqual(expected);
	expect(codec.fromDataTypeValue(pgJsonb.valueFrom(stored, {}))).toStrictEqual(
		expected,
	);
	expect(stored.date).toBe(iso);
	expect(schema.safeParse(stored).success).toBe(false);
});

it("retains union ordering, discriminators, intersections and recursion", async () => {
	const tree: z.ZodType = z.lazy(() =>
		z.object({ date: z.date(), children: z.array(tree) }),
	);
	const schema = z.object({
		choice: z.union([z.string(), z.date()]),
		hydrated: z.union([z.date(), z.string()]),
		tagged: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("date"), value: z.date() }),
			z.object({ kind: z.literal("text"), value: z.string() }),
		]),
		both: z.intersection(z.object({ a: z.date() }), z.object({ b: z.date() })),
		tree,
	});
	const input = {
		choice: iso,
		hydrated: iso,
		tagged: { kind: "date", value: iso },
		both: { a: iso, b: iso },
		tree: { date: iso, children: [{ date: iso, children: [] }] },
	};
	expect(await codecFor(schema).fromWire(input)).toStrictEqual({
		...input,
		hydrated: date,
		tagged: { kind: "date", value: date },
		both: { a: date, b: date },
		tree: { date, children: [{ date, children: [] }] },
	});
});

it("preserves wrappers, refinements, defaults and forward-only transforms", async () => {
	let calls = 0;
	const schema = z.object({
		date: z
			.date()
			.refine(async (v) => v.getUTCFullYear() === 2026)
			.transform((v) => {
				calls++;
				return v.getTime();
			}),
		fallback: z.date().default(date),
		nullish: z.date().nullish(),
		caught: z.date().catch(date),
		readonly: z.object({ date: z.date() }).readonly(),
	});
	const codec = codecFor(schema);
	const result = await codec.fromWire({
		date: iso,
		nullish: null,
		caught: "bad",
		readonly: { date: iso },
	});
	expect(result).toStrictEqual({
		date: date.getTime(),
		fallback: date,
		nullish: null,
		caught: date,
		readonly: { date },
	});
	expect(calls).toBe(1);
	expect(Object.isFrozen((result as { readonly: object }).readonly)).toBe(true);
	await expect(
		codec.fromWire({ date: "2025-01-01", readonly: { date: iso } }),
	).rejects.toMatchObject({
		issues: [expect.objectContaining({ path: ["date"] })],
	});
});

it("supports Mini and Date instance schemas", () => {
	expect(
		codecFor(mini.object({ date: mini.date() })).fromDataTypeValue(
			pgJsonb.valueFrom({ date: iso }, {}),
		),
	).toStrictEqual({ date });
	expect(
		codecFor(z.instanceof(Date)).fromDataTypeValue(pgJsonb.valueFrom(iso, {})),
	).toEqual(date);
});

it.each([
	[Temporal.Instant, "2026-09-12T00:00:00Z"],
	[Temporal.PlainDate, "2026-09-12"],
	[Temporal.PlainDateTime, "2026-09-12T13:45:30.123456789"],
	[Temporal.PlainMonthDay, "09-12"],
	[Temporal.PlainTime, "13:45:30.123456789"],
	[Temporal.PlainYearMonth, "2026-09"],
	[Temporal.ZonedDateTime, "2026-09-12T13:00:00+00:00[UTC]"],
	[Temporal.Duration, "P1DT2H"],
] as const)("hydrates %s from its schema constructor", async (cls, text) => {
	const value = cls.from(text);
	const codec = codecFor(z.object({ value: z.instanceof(cls) }));
	const wire = await codec.toWire({ value });
	expect(wire).toBe(JSON.stringify({ value }));
	expect(await codec.fromWire(JSON.parse(wire))).toEqual({ value });
	expect(
		codec.fromDataTypeValue(pgJsonb.valueFrom(JSON.parse(wire), {})),
	).toEqual({ value });
});

it("leaves application-defined representations to codecs and transforms", async () => {
	const schema = z.object({
		count: z.codec(z.string(), z.bigint(), { decode: BigInt, encode: String }),
		at: z.string().transform((v) => Temporal.PlainDateTime.from(v)),
	});
	const input = { count: "9007199254740993", at: "2026-09-12T12:00:00" };
	const codec = codecFor(schema);
	expect(await codec.toWire(input)).toBe(JSON.stringify(input));
	expect(await codec.fromWire(input)).toEqual({
		count: 9007199254740993n,
		at: Temporal.PlainDateTime.from(input.at),
	});
	const opaque = codecFor(z.custom<Date>((v) => v instanceof Date));
	await expect(opaque.fromWire(iso)).rejects.toThrow();
});

it("hydrates preprocess targets and recursive object getters", async () => {
	const tree = z.object({
		date: z.date(),
		get children(): z.ZodArray<typeof tree> {
			return z.array(tree);
		},
	});
	const codec = codecFor(z.preprocess((v) => v, tree));
	expect(
		await codec.fromWire({
			date: iso,
			children: [{ date: iso, children: [] }],
		}),
	).toEqual({ date, children: [{ date, children: [] }] });
});
