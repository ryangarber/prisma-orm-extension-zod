# Prisma 8 Zod extension

Zod 4 validation and separate write/read types for PostgreSQL `jsonb` columns, based on Prisma's official Arktype extension. Currently `@prisma/orm-postgres@8.0.0-rc.19`.

```sh
pnpm add @ryangarber/prisma-orm-extension-zod zod @prisma/orm-postgres@8.0.0-rc.19
pnpm add -D @prisma/orm-toolchain@8.0.0-rc.19
```

## Define schemas and register the extension

```ts
// schemas.ts
import { z } from "zod";
export const Profile = z.object({
  name: z.string().min(1),
  age: z.string().regex(/^\d+$/).transform(Number),
});
```

```ts
// zod-extension.ts
import { createZodExtension, defineZodSchema } from "@ryangarber/prisma-orm-extension-zod/column-types";
import type { CodecTypes } from "@ryangarber/prisma-orm-extension-zod/codec-types";
import { Profile } from "./schemas";

const schemas = { Profile: defineZodSchema(Profile) };
export type SchemaTypes = CodecTypes<typeof schemas>;
export const zodExtension = createZodExtension(schemas, {
  module: "./zod-extension", // resolved relative to emitted contract.d.ts
  export: "SchemaTypes",
});
```

Register all schemas in one extension instance, using identifier-shaped keys. Share this module between authoring, control, and runtime. `module` and `export` identify the exported **type map**, not a schema value. Derive that map from the same schema record with `CodecTypes<typeof schemas>`; a mismatched hand-written map can make generated types incorrect. Prisma imports it through its supported type-import mechanism; inline import expressions in codec renderers are rejected by Prisma 8.

## Prisma DSL contract

Use `zod.Json("Profile")` in a `.prisma` contract. The file must start with `// use prisma-8`. The string names a schema registered in `createZodExtension`; the extension supplies its type-map module and export automatically.

```prisma
// use prisma-8
model User {
  id      String @id @onCreate(uuid())
  profile zod.Json("Profile")

  @@map("users")
}
```

```ts
// prisma.config.ts
import { defineConfig } from "@prisma/orm-postgres/config";
import { zodExtension } from "./zod-extension";

export default defineConfig({
  contract: "./contract.prisma",
  extensions: [zodExtension.control],
});
```

Prisma DSL optional fields (`zod.Json("Profile")?`) and reusable aliases in `types {}` are supported. Unknown schema keys fail during contract emission. Schemas remain in TypeScript and use the same runtime registration and write/read semantics for both contract formats.

## TypeScript contract

```ts
// contract.ts
import { defineContract } from "@prisma/orm-postgres/contract-builder";
import { zodExtension } from "./zod-extension";

export const contract = defineContract(
  { extensions: { zod: zodExtension.pack } },
  ({ field, model }) => ({
    models: {
      User: model("User", {
        fields: {
          id: field.id.uuidv4String(),
          profile: field.column(zodExtension.column("Profile")),
        },
      }).sql({ table: "users" }),
    },
  }),
);
```

```ts
// prisma.config.ts
import { defineConfig } from "@prisma/orm-postgres/config";
import { zodExtension } from "./zod-extension";

export default defineConfig({
  contract: "./contract.ts",
  extensions: [zodExtension.control],
});
```

Supply `zodExtension.runtime` in the Postgres runtime's `extensions` array. Run `prisma contract emit` and use its generated `Contract` type for application queries. The emitted per-column input and output types resolve through the imported schema map to `z.input<typeof Profile>` and `z.output<typeof Profile>`, preserving unions, literals, brands, recursive schemas, and transforms. Prisma's un-emitted builder path may fall back to `unknown`; use emitted contracts for query inference.

## Emit, apply, and query

Keep the example files in the same directory so `module: "./zod-extension"` resolves from the generated `contract.d.ts`. Choose either `contract.prisma` or `contract.ts` in your config.

```sh
export DATABASE_URL="postgresql://localhost:5432/my_app"
pnpm prisma contract emit
pnpm prisma db update --dry-run
pnpm prisma db update
```

Review the database plan before applying it. For migration files and deployment workflows, use Prisma's `migration plan` / `db migrate` workflow. Emission generates `contract.json` and `contract.d.ts`; re-run it after changing the contract or schema registrations.

```ts
// db.ts
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import type { Contract } from "./contract.d";
import contractJson from "./contract.json" with { type: "json" };
import { zodExtension } from "./zod-extension";

export const contract = contractFromJson<Contract>(contractJson);

export const db = postgres({
  contract,
  url: process.env.DATABASE_URL,
  extensions: [zodExtension.runtime],
});
```

```ts
// example.ts
import { db } from "./db";

try {
  const user = await db.orm.public.User.create({
    profile: { name: "Ada", age: "36" },
  });
  console.log(user.profile.age); // 36 (number)
} finally {
  await db.close(); // Close short-lived scripts; keep a server's shared client open.
}
```

Both the control and runtime extension must come from the same schema registration. A missing schema key fails emission; a missing runtime registration fails codec resolution. A relative type-map path is relative to **the emitted declaration file**, so adjust it if you customize the output directory.

## Write and read semantics

Writes accept the schema **input**, validate it, and persist that input as JSON. Reads validate the stored input and return the schema **output**. For the example above, write `{ name: "Ada", age: "36" }` and read `{ name: "Ada", age: 36 }`. The database contains the string age. Output values are not automatically valid write inputs.

Transforms are not inverted and transformed output is not stored. This also applies to Zod codecs: their forward parse runs on reads; their reverse encode is not used. Refinements and transforms should be deterministic and free of side effects: write validation runs once before passing the original input to Prisma. Database comparisons operate on the stored input representation.

The original schema is registered at runtime, rather than converted to JSON Schema. This preserves custom refinements, preprocessors, transforms, codecs, and lazy types without serializing executable functions. Changing a schema requires considering existing data and re-emitting the contract; schema code changes are not captured by the contract hash.

Zod Classic and Mini types are accepted through `zod/v4/core`'s `$ZodType`. Query-time encode/decode support async schemas. Prisma's synchronous `toDataTypeValue`/`fromDataTypeValue` hooks cannot run async schemas; these throw for async refinements/transforms, including when Prisma uses those hooks for contract defaults. Use synchronous schemas for those paths.

## Native JSON storage and schema hydration

Writes delegate to Prisma's standard PostgreSQL JSONB codec with the original input. The extension does not rewrite values, call a replacer, add type tags, or reserve any keys. The synchronous JSON hook passes the original value through. PostgreSQL stores ordinary JSONB, so SQL JSON paths and functions see the application document directly (JSONB itself normalizes whitespace and key order).

Reads walk the registered Zod schema. Date strings in `z.date()` or `z.instanceof(Date)` positions become `Date` instances. Strings in `z.instanceof(Temporal.PlainDateTime)` and the other seven `ponyfill-temporal` constructor positions are restored using that constructor's `from` method. This includes `temporal-zod` instance schemas. Objects, arrays, tuples, records, unions, intersections, wrappers and lazy schemas retain Zod's validation and branching behavior. Union order determines which matching schema wins; use a discriminator or explicit codec when the JSON representation is ambiguous.

```ts
const Event = z.object({
  createdAt: z.date(),
  note: z.string().optional(),
  result: z.unknown(),
});
// Input: { createdAt: new Date("2026-09-12T00:00:00Z"), note: undefined,
//          result: { at: new Date("2026-09-12T00:00:00Z") } }
// Stored: { "createdAt": "2026-09-12T00:00:00.000Z",
//           "result": { "at": "2026-09-12T00:00:00.000Z" } }
// Read: createdAt is a Date; result.at remains a string; note stays absent.
```

Missing keys and nulls are passed to Zod unchanged; optional keys stay missing, nullable values stay null, and explicitly declared defaults/transforms retain their normal semantics. `z.any()` and `z.unknown()` never infer types from data. Native JSON rules apply: undefined object properties are omitted, undefined array entries and non-finite numbers become null, and Maps/Sets have no automatic rich representation. Bigints and cycles fail under native JSON encoding. PostgreSQL's own JSONB restrictions also apply.

Types that cannot be recovered from their schema and ordinary JSON must use a schema-defined codec or transform with a JSON-compatible input:

```ts
const Count = z.codec(z.string(), z.bigint(), {
  decode: (value) => BigInt(value),
  encode: (value) => value.toString(),
});
// Write "9007199254740993"; store that JSON string; read 9007199254740993n.
```

Opaque custom predicates and arbitrary classes are not guessed. Pipelines hydrate their input schema; their transformations own the output. No serializer callbacks or legacy storage decoder are supported. Previously tagged rows are treated as ordinary application JSON and may fail the current schema.

The driver must provide parsed JSONB values on reads, as the standard Postgres driver does. Raw JSON text is not guessed or automatically parsed, avoiding ambiguity for strings such as `"42"` or `"null"`. Validation failures retain Zod issue paths.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

The package exposes `column-types`, `codecs`, `codec-types`, `pack`, `control`, and `runtime`. The last three expose the configuration factory, whose result provides the corresponding descriptor. No process-global schema registry is used.

Run the opt-in PostgreSQL integration test against a local database:

```sh
pnpm build
ZOD_TEST_DATABASE_URL="postgresql://localhost:5432/postgres" pnpm exec vitest run test/postgres.test.ts
```

It requires `psql` and permission to create a schema. It creates a uniquely named schema, exercises Prisma ORM writes/reads and validation using the built package, checks the stored JSONB input, and drops its schema afterward. The test creates its table directly and disables contract-marker verification for that isolated runtime; it does not test migration application or signing.
