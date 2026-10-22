import { pgJsonb } from "@prisma/orm-postgres/target/data-types";
import {
	PlainDateTime,
	zPlainDateTime,
	zPlainDateTimeInstance,
} from "temporal-zod";

import { z } from "zod";
import {
	createZodExtension,
	defineZodSchema,
} from "../src/exports/column-types";

function codecFor(schema: z.core.$ZodType) {
	const extension = createZodExtension(
		{ value: defineZodSchema(schema) },
		{ module: "./schemas", export: "SchemaTypes" },
	);
	return extension.descriptor.factory(extension.column("value").typeParams)();
}

it.each(["2026-09-12T13:45:30.123456789", "2024-02-29T00:00:00"])(
	"round-trips zPlainDateTime strings and instances: %s",
	async (iso) => {
		const date = PlainDateTime.from(iso);
		for (const schema of [
			zPlainDateTime,
			z.object({ dates: z.array(zPlainDateTime) }),
		]) {
			const codec = codecFor(schema);
			for (const value of [iso, date]) {
				const input = schema === zPlainDateTime ? value : { dates: [value] };
				const expected = schema.parse(input);
				expect(await codec.fromWire(await codec.toWire(input))).toEqual(
					expected,
				);
				expect(codec.fromDataTypeValue(codec.toDataTypeValue(input))).toEqual(
					expected,
				);
			}
		}
		expect(
			await codecFor(zPlainDateTimeInstance).fromWire(
				await codecFor(zPlainDateTimeInstance).toWire(date),
			),
		).toEqual(date);
	},
);

it("rejects invalid Temporal values", async () => {
	const codec = codecFor(zPlainDateTime);
	await expect(codec.toWire("2026-02-30T00:00:00")).rejects.toThrow();
	await expect(codec.fromWire("not a date")).rejects.toThrow();
	expect(() =>
		codec.fromDataTypeValue(pgJsonb.valueFrom("not a date", {})),
	).toThrow();
});
