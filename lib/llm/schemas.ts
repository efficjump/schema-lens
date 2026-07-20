const stringArray = {
  type: "array",
  items: { type: "string" },
} as const;

export const mappingOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    additions: {
      type: "object",
      additionalProperties: false,
      properties: {
        nodes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              kind: { type: "string" },
              layer: {
                type: "string",
                enum: ["database", "source", "domain", "cross_layer"],
              },
              description: { type: "string" },
              mappedNodeIds: stringArray,
              evidenceIds: stringArray,
              confidence: { type: "number" },
            },
            required: [
              "id",
              "title",
              "kind",
              "layer",
              "description",
              "mappedNodeIds",
              "evidenceIds",
              "confidence",
            ],
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              source: { type: "string" },
              target: { type: "string" },
              kind: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
              evidenceIds: stringArray,
              confidence: { type: "number" },
            },
            required: [
              "id",
              "source",
              "target",
              "kind",
              "label",
              "description",
              "evidenceIds",
              "confidence",
            ],
          },
        },
        aliases: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              term: { type: "string" },
              nodeId: { type: "string" },
              description: { type: "string" },
              evidenceIds: stringArray,
              confidence: { type: "number" },
            },
            required: [
              "term",
              "nodeId",
              "description",
              "evidenceIds",
              "confidence",
            ],
          },
        },
      },
      required: ["nodes", "edges", "aliases"],
    },
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: {
            type: "string",
            enum: ["info", "warning", "error"],
          },
          code: { type: "string" },
          message: { type: "string" },
          relatedNodeIds: stringArray,
          evidenceIds: stringArray,
          suggestion: { type: "string" },
        },
        required: [
          "severity",
          "code",
          "message",
          "relatedNodeIds",
          "evidenceIds",
          "suggestion",
        ],
      },
    },
    unansweredQuestions: stringArray,
  },
  required: ["summary", "additions", "diagnostics", "unansweredQuestions"],
} as const;

export const answerOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["answered", "insufficient_evidence"],
    },
    answer: { type: "string" },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          citationIds: stringArray,
        },
        required: ["text", "citationIds"],
      },
    },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["graph", "excerpt"] },
          sourceId: { type: "string" },
          quote: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["id", "kind", "sourceId", "quote", "explanation"],
      },
    },
    referencedNodeIds: stringArray,
    limitations: stringArray,
    suggestedQuestions: stringArray,
  },
  required: [
    "status",
    "answer",
    "claims",
    "citations",
    "referencedNodeIds",
    "limitations",
    "suggestedQuestions",
  ],
} as const;
