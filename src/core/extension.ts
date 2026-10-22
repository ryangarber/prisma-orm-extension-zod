import { column } from "@prisma/orm-postgres/components/codec";
import type { SqlControlExtensionDescriptor } from "@prisma/orm-postgres/family/control";
import type { SqlRuntimeExtensionDescriptor } from "@prisma/orm-postgres/family-runtime";
import { pgText } from "@prisma/orm-postgres/target/data-types";
import type { CodecTypes } from "../exports/codec-types";
import {
	ZOD_CODEC_ID,
	ZOD_NATIVE_TYPE,
	ZodCodec,
	ZodDescriptor,
} from "./codec";
import type { ZodSchema } from "./schema";

/** Reuse the same definitions in contract authoring, control, and runtime. No global registry. */
export function createZodExtension<
	const Schemas extends Readonly<Record<string, ZodSchema>>,
>(
	schemas: Schemas,
	typeImport: { readonly module: string; readonly export: string },
) {
	if (
		!typeImport.module ||
		/["'\\\r\n]/.test(typeImport.module) ||
		!/^[A-Za-z_$][\w$]*$/.test(typeImport.export)
	) {
		throw new TypeError("Provide a valid type-map module and named export");
	}
	for (const key of Object.keys(schemas)) {
		if (!/^[A-Za-z_$][\w$]*$/.test(key))
			throw new TypeError("Schema keys must be TypeScript identifiers");
	}
	const reference = Object.freeze({ ...typeImport });
	const registered = Object.freeze({ ...schemas });
	const descriptor = new ZodDescriptor(registered, reference);
	const packBase = {
		kind: "extension",
		id: "zod",
		familyId: "sql",
		targetId: "postgres",
		version: "0.1.0",
		capabilities: {},
		authoring: {
			type: {
				zod: {
					Json: {
						kind: "typeConstructor",
						args: [{ kind: "value", dataType: pgText.id, name: "key" }],
						output: {
							codecId: ZOD_CODEC_ID,
							nativeType: ZOD_NATIVE_TYPE,
							typeParams: {
								key: { kind: "arg", index: 0 },
								module: reference.module,
								export: reference.export,
							},
						},
					},
				},
			},
		},
		types: {
			codecTypes: {
				codecDescriptors: [descriptor],
				import: {
					package: reference.module,
					named: reference.export,
					alias: "ZodTypes",
				},
			},
			storage: [
				{
					typeId: ZOD_CODEC_ID,
					familyId: "sql",
					targetId: "postgres",
					nativeType: ZOD_NATIVE_TYPE,
				},
			],
		},
	} as const;
	const pack: typeof packBase & {
		readonly __codecTypes?: CodecTypes<Schemas>;
	} = packBase;
	const control: SqlControlExtensionDescriptor<"postgres"> = {
		...pack,
		types: {
			...pack.types,
			codecTypes: {
				...pack.types.codecTypes,
				controlPlaneHooks: {
					[ZOD_CODEC_ID]: {
						expandNativeType: ({ nativeType }: { nativeType: string }) =>
							nativeType,
					},
				},
			},
		},
		create: () => ({ familyId: "sql", targetId: "postgres" }),
	};
	const runtime: SqlRuntimeExtensionDescriptor<"postgres"> = {
		...pack,
		codecs: () => [descriptor],
		create: () => ({ familyId: "sql", targetId: "postgres" }),
	};
	return {
		pack,
		control,
		runtime,
		descriptor,
		column<Key extends keyof Schemas & string>(key: Key) {
			const binding = Object.hasOwn(registered, key)
				? registered[key]
				: undefined;
			if (!binding) throw new Error(`Missing Zod schema: ${key}`);
			return column(
				() =>
					new ZodCodec<Schemas[Key]["schema"]>(
						descriptor,
						binding as ZodSchema<Schemas[Key]["schema"]>,
					),
				ZOD_CODEC_ID,
				{ key, module: reference.module, export: reference.export },
			);
		},
	};
}
