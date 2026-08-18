import createClient from "openapi-fetch";
import { mkdir, writeFile } from "node:fs/promises";
import type { paths } from "../../models/transform-synth-api/schema";

const baseUrl = "http://localhost:8000";

const client = createClient<paths>({ baseUrl });

type SynthesisRequest =
  paths["/v1/synthesize"]["post"]["requestBody"]["content"]["application/json"];

type SynthesisResponse =
  paths["/v1/synthesize"]["post"]["responses"]["200"]["content"]["application/json"];

type JsonSchema = Record<string, unknown>;

type SynthesisTask = Omit<
  SynthesisRequest,
  "inputSchema" | "outputSchema" | "examples"
> & {
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  examples: Array<{
    input: unknown;
    output: unknown;
  }>;
};

const objectAny: JsonSchema = {
  type: "object",
  additionalProperties: true,
};

const arrayOfObjects: JsonSchema = {
  type: "array",
  items: objectAny,
};

const lodashOnlyConstraints = {
  allowLodash: true,
  allowLibraries: ["lodash"],
  allowMutation: false,
  allowAsync: false,
  deterministic: true,
  maximumSourceCharacters: 20_000,
  executionTimeoutMs: 1_000,
  maxOutputBytes: 1_048_576,
} satisfies SynthesisRequest["constraints"];

function task(args: {
  functionName: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  examples: SynthesisTask["examples"];
  tags?: string[];
}): SynthesisTask {
  return {
    functionName: args.functionName,
    inputSchema: args.inputSchema,
    outputSchema: args.outputSchema,
    examples: args.examples,
    constraints: lodashOnlyConstraints,
    repairBudget: 8,
    candidateCount: 5,
    taskMetadata: {
      split: "adhoc",
      category: "complex-object-transform",
      tags: ["lodash-only", ...(args.tags ?? [])],
      benchmarkName: "manual-lodash-transform-suite",
      taskId: args.functionName,
      runnerVersion: null,
    },
    generatorConfig: {
      provider: null,
      model: null,
      version: "manual-script-v1",
      temperature: 0.2,
      maxTokens: 8_000,
    },
  };
}

const tasks: SynthesisTask[] = [
  task({
    functionName: "summarizeOrders",
    tags: ["orders", "aggregation", "grouping"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["orders"],
      properties: {
        orders: {
          type: "array",
          items: objectAny,
        },
      },
    },
    outputSchema: arrayOfObjects,
    examples: [
      {
        input: {
          orders: [
            {
              id: "o1",
              orderedAt: "2026-01-01T10:00:00Z",
              customer: { id: "c1", name: "Ada" },
              items: [
                {
                  sku: "burger",
                  category: "food",
                  quantity: 2,
                  unitPrice: 8,
                  discount: 1,
                },
                {
                  sku: "tea",
                  category: "drink",
                  quantity: 1,
                  unitPrice: 3,
                  discount: 0,
                },
              ],
            },
            {
              id: "o2",
              orderedAt: "2026-01-02T10:00:00Z",
              customer: { id: "c1", name: "Ada" },
              items: [
                {
                  sku: "burger",
                  category: "food",
                  quantity: 1,
                  unitPrice: 8,
                  discount: 0,
                },
              ],
            },
          ],
        },
        output: [
          {
            customerId: "c1",
            customerName: "Ada",
            orderCount: 2,
            itemCount: 4,
            grossRevenue: 27,
            discounts: 1,
            netRevenue: 26,
            categories: {
              food: 23,
              drink: 3,
            },
            skus: {
              burger: 3,
              tea: 1,
            },
          },
        ],
      },
    ],
  }),

  task({
    functionName: "buildOrgTree",
    tags: ["tree", "hierarchy", "org"],
    inputSchema: {
      type: "array",
      items: objectAny,
    },
    outputSchema: arrayOfObjects,
    examples: [
      {
        input: [
          { id: "ceo", name: "CEO", managerId: null, compensation: 100 },
          { id: "eng", name: "Eng", managerId: "ceo", compensation: 80 },
          { id: "dev", name: "Dev", managerId: "eng", compensation: 60 },
          { id: "sales", name: "Sales", managerId: "ceo", compensation: 70 },
        ],
        output: [
          {
            id: "ceo",
            name: "CEO",
            managerId: null,
            compensation: 100,
            reports: [
              {
                id: "eng",
                name: "Eng",
                managerId: "ceo",
                compensation: 80,
                reports: [
                  {
                    id: "dev",
                    name: "Dev",
                    managerId: "eng",
                    compensation: 60,
                    reports: [],
                    directReportCount: 0,
                    totalReportCount: 0,
                    totalCompensation: 60,
                  },
                ],
                directReportCount: 1,
                totalReportCount: 1,
                totalCompensation: 140,
              },
              {
                id: "sales",
                name: "Sales",
                managerId: "ceo",
                compensation: 70,
                reports: [],
                directReportCount: 0,
                totalReportCount: 0,
                totalCompensation: 70,
              },
            ],
            directReportCount: 2,
            totalReportCount: 3,
            totalCompensation: 310,
          },
        ],
      },
    ],
  }),

  task({
    functionName: "deepDiff",
    tags: ["diff", "recursive", "objects"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["before", "after"],
      properties: {
        before: objectAny,
        after: objectAny,
      },
    },
    outputSchema: objectAny,
    examples: [
      {
        input: {
          before: {
            id: 1,
            name: "Old",
            tags: ["a"],
            address: { city: "Indy", zip: "46201" },
          },
          after: {
            id: 1,
            name: "New",
            tags: ["a", "b"],
            address: { city: "Indy" },
            active: true,
          },
        },
        output: {
          added: [{ path: "active", value: true }, { path: "tags[1]", value: "b" }],
          removed: [{ path: "address.zip", value: "46201" }],
          changed: [{ path: "name", before: "Old", after: "New" }],
          unchanged: [
            { path: "id", value: 1 },
            { path: "tags[0]", value: "a" },
            { path: "address.city", value: "Indy" },
          ],
        },
      },
    ],
  }),

  task({
    functionName: "pivotEvents",
    tags: ["events", "pivot", "metrics"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["events"],
      properties: {
        events: {
          type: "array",
          items: objectAny,
        },
      },
    },
    outputSchema: arrayOfObjects,
    examples: [
      {
        input: {
          events: [
            {
              timestamp: "2026-01-01T01:00:00Z",
              entityId: "u1",
              type: "click",
              value: 2,
            },
            {
              timestamp: "2026-01-01T02:00:00Z",
              entityId: "u1",
              type: "view",
              value: 1,
            },
            {
              timestamp: "2026-01-02T01:00:00Z",
              entityId: "u1",
              type: "click",
              value: 3,
            },
          ],
        },
        output: [
          {
            date: "2026-01-01",
            entityId: "u1",
            totalValue: 3,
            eventCount: 2,
            byType: {
              click: { count: 1, value: 2 },
              view: { count: 1, value: 1 },
            },
          },
          {
            date: "2026-01-02",
            entityId: "u1",
            totalValue: 3,
            eventCount: 1,
            byType: {
              click: { count: 1, value: 3 },
            },
          },
        ],
      },
    ],
  }),

  task({
    functionName: "mergeProfiles",
    tags: ["merge", "dedupe", "precedence"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sources", "precedence"],
      properties: {
        sources: {
          type: "array",
          items: objectAny,
        },
        precedence: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    outputSchema: arrayOfObjects,
    examples: [
      {
        input: {
          precedence: ["crm", "billing"],
          sources: [
            {
              name: "billing",
              records: [
                {
                  userId: "u1",
                  name: "Ada B.",
                  email: "ada@billing.test",
                  roles: ["payer"],
                  address: { city: "Indy" },
                },
              ],
            },
            {
              name: "crm",
              records: [
                {
                  userId: "u1",
                  name: "Ada",
                  email: "ada@crm.test",
                  roles: ["admin"],
                  address: { state: "IN" },
                },
              ],
            },
          ],
        },
        output: [
          {
            userId: "u1",
            name: "Ada",
            email: "ada@crm.test",
            roles: ["payer", "admin"],
            address: {
              city: "Indy",
              state: "IN",
            },
            sources: ["crm", "billing"],
            conflictCount: 3,
          },
        ],
      },
    ],
  }),

  task({
    functionName: "flattenSchema",
    tags: ["json-schema", "flatten", "paths"],
    inputSchema: objectAny,
    outputSchema: arrayOfObjects,
    examples: [
      {
        input: {
          type: "object",
          required: ["id", "profile"],
          properties: {
            id: { type: "string", description: "Identifier" },
            profile: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                age: { type: "number", default: 0 },
              },
            },
          },
        },
        output: [
          {
            path: "$",
            type: "object",
            required: false,
            enum: null,
            description: null,
          },
          {
            path: "$.id",
            type: "string",
            required: true,
            enum: null,
            description: "Identifier",
          },
          {
            path: "$.profile",
            type: "object",
            required: true,
            enum: null,
            description: null,
          },
          {
            path: "$.profile.name",
            type: "string",
            required: true,
            enum: null,
            description: null,
          },
          {
            path: "$.profile.age",
            type: "number",
            required: false,
            enum: null,
            default: 0,
            description: null,
          },
        ],
      },
    ],
  }),

  task({
    functionName: "rollupInventory",
    tags: ["inventory", "running-balance", "aggregation"],
    inputSchema: {
      type: "array",
      items: objectAny,
    },
    outputSchema: arrayOfObjects,
    examples: [
      {
        input: [
          {
            itemId: "burger",
            locationId: "main",
            recordedAt: "2026-01-01T10:00:00Z",
            quantity: 10,
            type: "stock",
          },
          {
            itemId: "burger",
            locationId: "main",
            recordedAt: "2026-01-01T12:00:00Z",
            quantity: -3,
            type: "sale",
          },
          {
            itemId: "burger",
            locationId: "main",
            recordedAt: "2026-01-02T10:00:00Z",
            quantity: 5,
            type: "stock",
          },
        ],
        output: [
          {
            itemId: "burger",
            locationId: "main",
            date: "2026-01-01",
            delta: 7,
            balance: 7,
            movementCount: 2,
            byType: {
              stock: 10,
              sale: -3,
            },
          },
          {
            itemId: "burger",
            locationId: "main",
            date: "2026-01-02",
            delta: 5,
            balance: 12,
            movementCount: 1,
            byType: {
              stock: 5,
            },
          },
        ],
      },
    ],
  }),

  task({
    functionName: "denormalizeProjectData",
    tags: ["denormalize", "relations", "nested-documents"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projects", "tasks", "comments", "users"],
      properties: {
        projects: { type: "array", items: objectAny },
        tasks: { type: "array", items: objectAny },
        comments: { type: "array", items: objectAny },
        users: { type: "array", items: objectAny },
      },
    },
    outputSchema: arrayOfObjects,
    examples: [
      {
        input: {
          projects: [{ id: "p1", name: "Build" }],
          tasks: [
            { id: "t1", projectId: "p1", title: "API", status: "done", assigneeId: "u1" },
            { id: "t2", projectId: "p1", title: "UI", status: "open", assigneeId: "u2" },
          ],
          comments: [
            { id: "c1", taskId: "t1", authorId: "u2", body: "ok", createdAt: "2026-01-01" },
          ],
          users: [
            { id: "u1", name: "Ada" },
            { id: "u2", name: "Grace" },
          ],
        },
        output: [
          {
            id: "p1",
            name: "Build",
            tasks: [
              {
                id: "t1",
                projectId: "p1",
                title: "API",
                status: "done",
                assigneeId: "u1",
                assignee: { id: "u1", name: "Ada" },
                comments: [
                  {
                    id: "c1",
                    taskId: "t1",
                    authorId: "u2",
                    body: "ok",
                    createdAt: "2026-01-01",
                    author: { id: "u2", name: "Grace" },
                  },
                ],
                commentCount: 1,
                lastCommentAt: "2026-01-01",
              },
              {
                id: "t2",
                projectId: "p1",
                title: "UI",
                status: "open",
                assigneeId: "u2",
                assignee: { id: "u2", name: "Grace" },
                comments: [],
                commentCount: 0,
                lastCommentAt: null,
              },
            ],
            taskCount: 2,
            completedTaskCount: 1,
            openTaskCount: 1,
            members: [
              { id: "u1", name: "Ada" },
              { id: "u2", name: "Grace" },
            ],
          },
        ],
      },
    ],
  }),

  task({
    functionName: "redactByPolicy",
    tags: ["redaction", "policy", "recursive"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value", "policy"],
      properties: {
        value: objectAny,
        policy: objectAny,
      },
    },
    outputSchema: objectAny,
    examples: [
      {
        input: {
          value: {
            id: "u1",
            email: "ada@example.com",
            profile: {
              ssn: "123-45-6789",
              name: "Ada",
            },
            cards: [{ number: "4111111111111111" }],
          },
          policy: {
            exactPaths: ["profile.ssn"],
            keyPatterns: ["card|number"],
            redactEmails: true,
            replacement: "[REDACTED]",
          },
        },
        output: {
          id: "u1",
          email: "[REDACTED]",
          profile: {
            ssn: "[REDACTED]",
            name: "Ada",
          },
          cards: [{ number: "[REDACTED]" }],
        },
      },
    ],
  }),

  task({
    functionName: "reconcileLedgers",
    tags: ["ledger", "reconciliation", "matching"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["primary", "secondary"],
      properties: {
        primary: { type: "array", items: objectAny },
        secondary: { type: "array", items: objectAny },
        options: objectAny,
      },
    },
    outputSchema: objectAny,
    examples: [
      {
        input: {
          primary: [
            { id: "a", date: "2026-01-01", amount: 10 },
            { id: "b", date: "2026-01-02", amount: 20 },
            { id: "c", date: "2026-01-03", amount: 30 },
          ],
          secondary: [
            { id: "a", date: "2026-01-01", amount: 10.005 },
            { id: "b", date: "2026-01-05", amount: 22 },
            { id: "d", date: "2026-01-04", amount: 40 },
          ],
          options: {
            tolerance: 0.01,
          },
        },
        output: {
          matches: [
            {
              id: "a",
              primary: { id: "a", date: "2026-01-01", amount: 10 },
              secondary: { id: "a", date: "2026-01-01", amount: 10.005 },
            },
          ],
          mismatches: [
            {
              id: "b",
              primary: { id: "b", date: "2026-01-02", amount: 20 },
              secondary: { id: "b", date: "2026-01-05", amount: 22 },
              differences: {
                amountDelta: -2,
                dateMatches: false,
                amountMatches: false,
              },
            },
          ],
          missingInPrimary: [{ id: "d", date: "2026-01-04", amount: 40 }],
          missingInSecondary: [{ id: "c", date: "2026-01-03", amount: 30 }],
          summary: {
            matchCount: 1,
            mismatchCount: 1,
            missingInPrimaryCount: 1,
            missingInSecondaryCount: 1,
            primaryTotal: 60,
            secondaryTotal: 72.005,
          },
        },
      },
    ],
  }),
];

async function synthesize(task: SynthesisTask): Promise<SynthesisResponse> {
  const { data, error, response } = await client.POST("/v1/synthesize", {
    // Cast is useful because inputSchema/outputSchema are arbitrary JSON Schema docs,
    // while generated OpenAPI object types can sometimes be too narrow.
    body: task as unknown as SynthesisRequest,
  });

  if (error) {
    throw new Error(
      `Synthesis failed for ${task.functionName} with HTTP ${response.status}: ${JSON.stringify(
        error,
        null,
        2,
      )}`,
    );
  }

  if (!data) {
    throw new Error(`Synthesis returned no data for ${task.functionName}`);
  }

  return data;
}

async function main() {
  const health = await client.GET("/health");

  if (!health.response.ok) {
    throw new Error(`Health check failed with HTTP ${health.response.status}`);
  }

  await mkdir("generated-synth", { recursive: true });

  const results: Array<{
    functionName: string;
    accepted: boolean;
    score: number;
    attemptId: string | null;
    candidatePath: string | null;
  }> = [];

  for (const task of tasks) {
    console.log(`Synthesizing ${task.functionName}...`);

    const result = await synthesize(task);

    const score = result.evaluation?.score ?? 0;
    const candidatePath =
      result.accepted && result.candidateSource
        ? `generated-synth/${task.functionName}.js`
        : null;

    if (candidatePath && result.candidateSource) {
      await writeFile(candidatePath, `${result.candidateSource}\n`, "utf8");
    }

    results.push({
      functionName: task.functionName,
      accepted: result.accepted,
      score,
      attemptId: result.attemptId ?? null,
      candidatePath,
    });

    console.log({
      functionName: task.functionName,
      accepted: result.accepted,
      score,
      attemptId: result.attemptId,
      candidatePath,
    });

    if (!result.accepted) {
      console.dir(result.evaluation?.diagnostics ?? [], { depth: null });
    }
  }

  await writeFile(
    "generated-synth/results.json",
    JSON.stringify(results, null, 2),
    "utf8",
  );

  console.table(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
