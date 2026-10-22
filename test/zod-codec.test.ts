import { pgJsonb } from "@prisma/orm-postgres/target/data-types";
import { z } from "zod";
import * as mini from "zod/mini";
import {
	createZodExtension,
	defineZodSchema,
} from "../src/exports/column-types";

function setup<S extends z.core.$ZodType>(schema: S) {
	const extension = extensionFor({
		value: defineZodSchema(schema),
	});
	return {
		extension,
		codec: extension.descriptor.factory(extension.column("value").typeParams)(),
	};
}

it("validates both writes and reads", async () => {
	const { codec } = setup(z.object({ count: z.number().int().positive() }));
	await expect(codec.toWire({ count: 2 })).resolves.toBe('{"count":2}');
	await expect(codec.fromWire('{"count":2}')).resolves.toEqual({ count: 2 });
	await expect(codec.toWire({ count: -1 })).rejects.toThrow();
	await expect(codec.fromWire('{"count":-1}')).rejects.toThrow();
	expect(() => codec.toDataTypeValue({ count: -1 })).toThrow();
	expect(() =>
		codec.fromDataTypeValue(pgJsonb.valueFrom({ count: -1 }, {})),
	).toThrow();
});

it("persists input and applies non-idempotent transforms once on each read", async () => {
	const { codec } = setup(z.string().transform((value) => `${value}!`));
	const wire = await codec.toWire("hello");
	expect(wire).toBe('"hello"');
	await expect(codec.fromWire(wire)).resolves.toBe("hello!");
	expect(codec.fromDataTypeValue(codec.toDataTypeValue("hello"))).toBe(
		"hello!",
	);
});

it.each(['"hello"', "true", "null", "42", '{"a":1}'])(
	"decodes JSONB string wire %s exactly once",
	async (value) => {
		const { codec } = setup(z.string());
		await expect(codec.fromWire(JSON.stringify(value))).resolves.toBe(value);
		expect(codec.fromDataTypeValue(pgJsonb.valueFrom(value, {}))).toBe(value);
	},
);

it("distinguishes JSONB strings from other JSONB scalar wires", async () => {
	const { codec } = setup(z.string());
	await expect(codec.fromWire('"hello"')).resolves.toBe("hello");
	await expect(codec.fromWire("true")).rejects.toThrow();
	await expect(codec.fromWire("42")).rejects.toThrow();
	await expect(codec.fromWire("not JSON")).rejects.toThrow(SyntaxError);
});

it("preserves refinements after serialized type params are reloaded", async () => {
	const binding = defineZodSchema(z.string().refine((s) => s.startsWith("ok")));
	const authored = extensionFor({ value: binding });
	const params = JSON.parse(
		JSON.stringify(authored.column("value").typeParams),
	);
	const loaded = extensionFor({ value: binding });
	const codec = loaded.descriptor.factory(params)();
	await expect(codec.toWire("bad")).rejects.toThrow();
	await expect(codec.fromWire('"ok!"')).resolves.toBe("ok!");
	expect(() =>
		loaded.descriptor.factory({ ...params, export: "Other" }),
	).toThrow("mismatched");
	expect(() =>
		loaded.descriptor.factory({ ...params, key: "toString" }),
	).toThrow("Missing");
});

it("supports async validation and transforms at the query boundary", async () => {
	const { codec } = setup(z.string().transform(async (s) => s.length));
	await expect(codec.toWire("abcd")).resolves.toBe('"abcd"');
	await expect(codec.fromWire('"abcd"')).resolves.toBe(4);
	expect(() =>
		codec.fromDataTypeValue(pgJsonb.valueFrom("abcd", {})),
	).toThrow();
	expect(() => codec.toDataTypeValue("abcd")).toThrow();
});

it("supports Mini, unions, lazy schemas and defaults", async () => {
	await expect(setup(mini.string()).codec.fromWire('"mini"')).resolves.toBe(
		"mini",
	);
	const recursive = z.lazy(() => z.object({ name: z.string() }));
	await expect(
		setup(recursive).codec.fromWire('{"name":"a"}'),
	).resolves.toEqual({
		name: "a",
	});
	await expect(
		setup(z.union([z.number(), z.string()])).codec.fromWire("2"),
	).resolves.toBe(2);
	await expect(
		setup(z.object({ name: z.string().default("guest") })).codec.fromWire("{}"),
	).resolves.toEqual({ name: "guest" });
});

it("keeps emitter callbacks bound and resolves both type-map positions", () => {
	const { extension } = setup(z.string().transform(Number));
	const { factory, renderInputType, renderOutputType } = extension.descriptor;
	const params = extension.column("value").typeParams;
	expect(factory(params)().fromDataTypeValue(pgJsonb.valueFrom("36", {}))).toBe(
		36,
	);
	expect(renderInputType(params)).toBe(
		'ZodTypes["zod/json@1"]["schemas"]["value"]["input"]',
	);
	expect(renderOutputType(params)).toBe(
		'ZodTypes["zod/json@1"]["schemas"]["value"]["output"]',
	);
	expect(extension.control.types?.codecTypes?.codecDescriptors).toEqual([
		extension.descriptor,
	]);
	expect(extension.runtime.codecs?.()).toEqual([extension.descriptor]);
});

function extensionFor<
	const S extends Readonly<
		Record<string, import("../src/core/schema").ZodSchema>
	>,
>(schemas: S) {
	return createZodExtension(schemas, {
		module: "./schemas",
		export: "SchemaTypes",
	});
}

it("accepts Zod codecs without reversing their transformations", async () => {
	const schema = z.codec(z.string(), z.number(), {
		decode: Number,
		encode: String,
	});
	const { codec } = setup(schema);
	await expect(codec.toWire("12")).resolves.toBe('"12"');
	await expect(codec.fromWire('"12"')).resolves.toBe(12);
});

it("omits undefined object fields using native JSON semantics", async () => {
	const { codec } = setup(z.object({ a: z.string().optional() }));
	const value = { a: undefined };
	expect(await codec.toWire(value)).toBe("{}");
	expect(codec.toDataTypeValue(value).value).toBe(value);
	expect(await codec.fromWire("{}")).toStrictEqual({});
});
