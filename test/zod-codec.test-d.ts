import { expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
	createZodExtension,
	defineZodSchema,
} from "../src/exports/column-types";

it("preserves schema input and output types", () => {
	const transformed = z.string().transform((s) => s.length);
	const branded = z.string().brand<"ID">();
	const extension = extensionFor({
		transformed: defineZodSchema(transformed),
		branded: defineZodSchema(branded),
		literal: defineZodSchema(z.literal("hello")),
	});
	type Transformed = ReturnType<
		ReturnType<typeof extension.column<"transformed">>["codecFactory"]
	>;
	expectTypeOf<Parameters<Transformed["toWire"]>[0]>().toEqualTypeOf<string>();
	expectTypeOf<
		Awaited<ReturnType<Transformed["fromWire"]>>
	>().toEqualTypeOf<number>();
	expectTypeOf<
		Parameters<Transformed["toDataTypeValue"]>[0]
	>().toEqualTypeOf<string>();
	expectTypeOf<
		ReturnType<Transformed["fromDataTypeValue"]>
	>().toEqualTypeOf<number>();
	type Branded = ReturnType<
		ReturnType<typeof extension.column<"branded">>["codecFactory"]
	>;
	expectTypeOf<Parameters<Branded["toWire"]>[0]>().toEqualTypeOf<string>();
	expectTypeOf<Awaited<ReturnType<Branded["fromWire"]>>>().toEqualTypeOf<
		z.output<typeof branded>
	>();
	type Literal = ReturnType<
		ReturnType<typeof extension.column<"literal">>["codecFactory"]
	>;
	expectTypeOf<
		Awaited<ReturnType<Literal["fromWire"]>>
	>().toEqualTypeOf<"hello">();
	// @ts-expect-error Unknown registration key
	extension.column("missing");
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
