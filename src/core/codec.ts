import {
	CodecImpl,
	type DataTypeValue,
} from "@prisma/orm-postgres/components/codec";
import type { JsonValue } from "@prisma/orm-postgres/contract/types";
import {
	CastExpr,
	type ProjectionExpr,
} from "@prisma/orm-postgres/relational-core/ast";
import { PostgresCodecDescriptor } from "@prisma/orm-postgres/target/codec-descriptor";
import { postgresCodecRegistry } from "@prisma/orm-postgres/target/codecs";
import { pgJsonb } from "@prisma/orm-postgres/target/data-types";
import { z } from "zod";
import {
	type $ZodType,
	type input,
	type output,
	parse,
	parseAsync,
} from "zod/v4/core";
import { hydrationSchema } from "./hydration";
import type { ZodSchema } from "./schema";

const jsonbDescriptor = postgresCodecRegistry.descriptorFor("pg/jsonb@1");
if (!jsonbDescriptor)
	throw new Error("Prisma PostgreSQL JSONB codec is unavailable");
const jsonb = jsonbDescriptor.factory(undefined)({ name: "zod/json" });

export const ZOD_CODEC_ID = "zod/json@1" as const;
export const ZOD_NATIVE_TYPE = "jsonb" as const;
export type ZodTypeParams = {
	readonly key: string;
	readonly module: string;
	readonly export: string;
};

/** Input is persisted, output is produced by parsing on reads; transforms are never inverted. */
export class ZodCodec<S extends $ZodType> extends CodecImpl<
	typeof ZOD_CODEC_ID,
	readonly ["equality"],
	string | JsonValue,
	unknown
> {
	constructor(
		descriptor: ZodDescriptor,
		private readonly binding: ZodSchema<S>,
	) {
		super(descriptor, pgJsonb);
		this.readSchema = hydrationSchema(binding.schema);
	}
	private readonly readSchema: $ZodType;
	async toWire(value: input<S>): Promise<string> {
		await parseAsync(this.binding.schema, value);
		return jsonb.toWire(value, {}) as Promise<string>;
	}
	async fromWire(wire: string | JsonValue): Promise<output<S>> {
		const value = await jsonb.fromWire(wire, {});
		return parseAsync(this.readSchema, value) as Promise<output<S>>;
	}
	toDataTypeValue(value: input<S>): DataTypeValue {
		parse(this.binding.schema, value);
		return jsonb.toDataTypeValue(value);
	}
	fromDataTypeValue(value: DataTypeValue): output<S> {
		return parse(this.readSchema, value.value) as output<S>;
	}
}

export class ZodDescriptor extends PostgresCodecDescriptor<ZodTypeParams> {
	override readonly dataType = pgJsonb.id;
	override readonly codecId = ZOD_CODEC_ID;
	override readonly traits = ["equality"] as const;
	override readonly paramsSchema = z.object({
		key: z.string(),
		module: z.string(),
		export: z.string(),
	});
	constructor(
		private readonly schemas: Readonly<Record<string, ZodSchema>>,
		private readonly reference: {
			readonly module: string;
			readonly export: string;
		},
	) {
		super();
	}
	// Match pg/jsonb: includes read the printed text through fromWire, like plain rows.
	protected override jsonProjection(expression: ProjectionExpr) {
		return CastExpr.as(expression, "text");
	}
	private lookup(params: ZodTypeParams): ZodSchema {
		const binding = Object.hasOwn(this.schemas, params.key)
			? this.schemas[params.key]
			: undefined;
		if (
			!binding ||
			this.reference.module !== params.module ||
			this.reference.export !== params.export
		) {
			throw new Error(
				`Missing or mismatched Zod schema registration: ${params.key}`,
			);
		}
		return binding;
	}
	override readonly factory = (params: ZodTypeParams) => {
		const binding = this.lookup(params);
		return () => new ZodCodec(this, binding);
	};
	override readonly renderInputType = (params: ZodTypeParams) =>
		this.render(params, "input");
	override readonly renderOutputType = (params: ZodTypeParams) =>
		this.render(params, "output");
	private render(params: ZodTypeParams, side: "input" | "output") {
		this.lookup(params);
		return `ZodTypes["zod/json@1"]["schemas"][${JSON.stringify(params.key)}]["${side}"]`;
	}
}
