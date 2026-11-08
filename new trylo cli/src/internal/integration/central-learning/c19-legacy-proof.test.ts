import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createCentralDeliberationReceiptsAtRoot, readCentralDeliberationDeliveriesFromFacts, type CentralDeliberationDelivery } from "./deliberation-receipts.js";
import { isCentralDeliberationWireEvidence } from "./deliberation-wire-evidence.js";

// Generated once by formal C18 dist, not this candidate's renderer/compiler.
// Original deliberation-wire-evidence.js SHA256:
// 5932d917ab79287ef10d9c95917ba3ebc80824ec215fdad7597fd9997bdbfc7a.
// The private generator only resolved imports to frozen baseline files and
// exported its original reconstruct. v1 retains its historical nested read;
// v2/v3 bind the own-material read. No provider or live Board was involved.
const FROZEN_C18 = [
  {
    "request": {
      "schemaVersion": 1,
      "scope": "project:c19-frozen-proof",
      "budgetId": "budget:c19-frozen-proof",
      "boardSequence": 0,
      "resources": {
        "boardSequence": 0,
        "budgetId": "budget:c19-frozen-proof",
        "limits": {
          "tokens": 100000,
          "calls": 4,
          "steps": 4
        },
        "occupied": {
          "tokens": 0,
          "calls": 0,
          "steps": 0
        },
        "available": {
          "tokens": 100000,
          "calls": 4,
          "steps": 4
        },
        "status": "available",
        "holdReason": null
      },
      "configuration": {
        "schemaVersion": 1,
        "configurationRef": "configuration:frozen-original",
        "authorizationRef": "authorization:frozen-original",
        "allowance": {
          "schemaVersion": 2,
          "unit": "total_model_tokens",
          "maxTokens": 100000,
          "maxCalls": 4,
          "maxSteps": 4,
          "maxPromptChars": 100000
        }
      },
      "stateRef": "state:frozen-original",
      "state": {
        "schemaVersion": 1,
        "scope": "project:c19-frozen-proof",
        "intents": [],
        "completed": [],
        "running": [],
        "materials": [],
        "consumedSourceRefs": []
      },
      "opportunities": [],
      "organization": [],
      "materials": [
        {
          "ref": "source:frozen-original",
          "kind": "source",
          "text": "{\"description\":\"Actual archived public source.\",\"nested\":{\"readRef\":\"source:frozen-legacy-address\"}}",
          "sourceRefs": [
            "source:frozen-original"
          ]
        }
      ],
      "operation": {
        "kind": "think",
        "operationId": "operation:frozen-v1",
        "purpose": "Choose a source-bound next read.",
        "expectedChange": "Resolve original public source.",
        "sourceRefs": [
          "source:frozen-original"
        ]
      }
    },
    "output": {
      "schemaVersion": 1,
      "intents": [],
      "publicExplanation": "Read the original before changing a purpose.",
      "sourceRefs": [
        "source:frozen-original"
      ],
      "agendaRead": {
        "kind": "read",
        "operationId": "central-change-inspection:2543b889de10837f99897587278f14212d729ec8412a62333b30558c41eca20f",
        "purpose": "Open the original.",
        "expectedChange": "Obtain delivered original text.",
        "sourceRefs": [
          "source:frozen-original"
        ],
        "refs": [
          "source:frozen-legacy-address"
        ],
        "maximumChars": 1024
      }
    },
    "proof": {
      "schemaVersion": 1,
      "type": "central_deliberation_wire_evidence",
      "projectionVersion": "central-learning-change-v1",
      "inputVersion": "central-learning-change-input-v1",
      "checkpoint": "central-input-checkpoint:58941036e108e2f5e31ecdbd6ddd62e7cbd9562bff101c46f797be7e1982693b",
      "requestHash": "58941036e108e2f5e31ecdbd6ddd62e7cbd9562bff101c46f797be7e1982693b",
      "dictionaryHash": "77122cdde88325ae4a6d51f64fe12703e218d675e64cbd6eae6c4b35fee87af3",
      "viewHash": "4a5f445ca63b95a769de2cfa9259bc84047595555d541fedc27ef1eea23ed5c7",
      "exposure": [
        {
          "ref": "source:frozen-original",
          "kind": "body",
          "textHash": "1e023d4d4a5b8135ea30a04ab04ed3487da46079cfa2ed3598abd4babb90ad81",
          "readRefs": [
            "source:frozen-legacy-address",
            "source:frozen-original"
          ]
        }
      ],
      "messagesHash": "59d1ae5e17c590be07ea44ce1c198f4f4cb9572a4aab30fd6a9eadc01f30af47",
      "toolsHash": "cac0c8eded00e194ce259d7c820ca2effc26a7cc4d5c0d312efab244a32300e7",
      "responseSchemaHash": null,
      "maxOutputTokens": 8192,
      "outputHash": "28101e9bad8f2a876844efbcfa2000684ad6f56e3463302861ba5ed16a9d1fc0",
      "format": {
        "kind": "tool",
        "description": "Return only this public learning change."
      },
      "fundingMessage": {
        "role": "user",
        "content": "{\"available\":{\"calls\":3,\"steps\":3,\"tokens\":80000},\"budgetId\":\"budget:c19-frozen-proof\",\"holdReason\":null,\"interpretation\":\"current_root_resources_not_new_authorization_or_value_prediction\",\"limits\":{\"calls\":4,\"steps\":4,\"tokens\":100000},\"occupied\":{\"calls\":1,\"steps\":1,\"tokens\":20000},\"role\":\"host_original_root_after_this_computation_reservation\",\"status\":\"available\",\"thisComputation\":{\"calls\":1,\"maxTokens\":20000,\"reservationId\":\"central-deliberation:e6bbf10faefba9fa041bbe70699e740a6d5d429486eb5bdc6cc0329898e635b6\",\"steps\":1}}"
      },
      "rawChange": {
        "checkpoint": "central-input-checkpoint:58941036e108e2f5e31ecdbd6ddd62e7cbd9562bff101c46f797be7e1982693b",
        "changes": [],
        "explanation": "Read the original before changing a purpose.",
        "sources": [
          "b58941036e108_2"
        ],
        "inspect": {
          "purpose": "Open the original.",
          "expectedChange": "Obtain delivered original text.",
          "refs": [
            "r58941036e108_3"
          ],
          "maximumChars": 1024,
          "sources": [
            "b58941036e108_2"
          ]
        }
      }
    },
    "proofHash": "8067b42cc1f795414df608abf5fd27e2b961ea9790baaff49f6b4dec0cda2d73"
  },
  {
    "request": {
      "schemaVersion": 1,
      "scope": "project:c19-frozen-proof",
      "budgetId": "budget:c19-frozen-proof",
      "boardSequence": 0,
      "resources": {
        "boardSequence": 0,
        "budgetId": "budget:c19-frozen-proof",
        "limits": {
          "tokens": 100000,
          "calls": 4,
          "steps": 4
        },
        "occupied": {
          "tokens": 0,
          "calls": 0,
          "steps": 0
        },
        "available": {
          "tokens": 100000,
          "calls": 4,
          "steps": 4
        },
        "status": "available",
        "holdReason": null
      },
      "configuration": {
        "schemaVersion": 1,
        "configurationRef": "configuration:frozen-original",
        "authorizationRef": "authorization:frozen-original",
        "allowance": {
          "schemaVersion": 2,
          "unit": "total_model_tokens",
          "maxTokens": 100000,
          "maxCalls": 4,
          "maxSteps": 4,
          "maxPromptChars": 100000
        }
      },
      "stateRef": "state:frozen-original",
      "state": {
        "schemaVersion": 1,
        "scope": "project:c19-frozen-proof",
        "intents": [],
        "completed": [],
        "running": [],
        "materials": [],
        "consumedSourceRefs": []
      },
      "opportunities": [],
      "organization": [],
      "materials": [
        {
          "ref": "source:frozen-original",
          "kind": "source",
          "text": "{\"description\":\"Actual archived public source.\",\"nested\":{\"readRef\":\"source:frozen-legacy-address\"}}",
          "sourceRefs": [
            "source:frozen-original"
          ]
        }
      ],
      "operation": {
        "kind": "think",
        "operationId": "operation:frozen-v2",
        "purpose": "Choose a source-bound next read.",
        "expectedChange": "Resolve original public source.",
        "sourceRefs": [
          "source:frozen-original"
        ]
      }
    },
    "output": {
      "schemaVersion": 1,
      "intents": [],
      "publicExplanation": "Read the original before changing a purpose.",
      "sourceRefs": [
        "source:frozen-original"
      ],
      "agendaRead": {
        "kind": "read",
        "operationId": "central-change-inspection:586af76a3aa4c282f199c46f09da0143197ff5abeaa49c3073677c52ce5364df",
        "purpose": "Open the original.",
        "expectedChange": "Obtain delivered original text.",
        "sourceRefs": [
          "source:frozen-original"
        ],
        "refs": [
          "source:frozen-original"
        ],
        "maximumChars": 1024
      }
    },
    "proof": {
      "schemaVersion": 1,
      "type": "central_deliberation_wire_evidence",
      "projectionVersion": "central-learning-change-v1",
      "inputVersion": "central-learning-change-input-v2",
      "checkpoint": "central-input-checkpoint:ddb632f29e4b4d07f2d94c27d9548124cfcfbce3e30d5a3b48349c5b12d99975",
      "requestHash": "ddb632f29e4b4d07f2d94c27d9548124cfcfbce3e30d5a3b48349c5b12d99975",
      "dictionaryHash": "36136b43cb3d7c068741a5c7c795c90d415d739734385f1630a90f61e19f60eb",
      "viewHash": "47d7e347ff62d8d8b16d1fc4c0d04f420822d8f316405d493112babc5a8657ed",
      "exposure": [
        {
          "ref": "source:frozen-original",
          "kind": "body",
          "textHash": "1e023d4d4a5b8135ea30a04ab04ed3487da46079cfa2ed3598abd4babb90ad81",
          "readRefs": [
            "source:frozen-original"
          ]
        }
      ],
      "messagesHash": "ccfd032021fc8d679c53a9cb1a59f38759399cb01185395299d4089dfaadc159",
      "toolsHash": "cac0c8eded00e194ce259d7c820ca2effc26a7cc4d5c0d312efab244a32300e7",
      "responseSchemaHash": null,
      "maxOutputTokens": 8192,
      "outputHash": "fa4b32418d4b232cc2efd657b1f707b3c64e4b7ae1db043ae63679b5c429c19f",
      "format": {
        "kind": "tool",
        "description": "Return only this public learning change."
      },
      "fundingMessage": {
        "role": "user",
        "content": "{\"available\":{\"calls\":3,\"steps\":3,\"tokens\":80000},\"budgetId\":\"budget:c19-frozen-proof\",\"holdReason\":null,\"interpretation\":\"current_root_resources_not_new_authorization_or_value_prediction\",\"limits\":{\"calls\":4,\"steps\":4,\"tokens\":100000},\"occupied\":{\"calls\":1,\"steps\":1,\"tokens\":20000},\"role\":\"host_original_root_after_this_computation_reservation\",\"status\":\"available\",\"thisComputation\":{\"calls\":1,\"maxTokens\":20000,\"reservationId\":\"central-deliberation:ac17ba5e2d2f66345a1b8aba90098f4747ec4ec5a7f842216f70df7253cc7c5d\",\"steps\":1}}"
      },
      "rawChange": {
        "checkpoint": "central-input-checkpoint:ddb632f29e4b4d07f2d94c27d9548124cfcfbce3e30d5a3b48349c5b12d99975",
        "changes": [],
        "explanation": "Read the original before changing a purpose.",
        "sources": [
          "bddb632f29e4b_2"
        ],
        "inspect": {
          "purpose": "Open the original.",
          "expectedChange": "Obtain delivered original text.",
          "refs": [
            "rddb632f29e4b_3"
          ],
          "maximumChars": 1024,
          "sources": [
            "bddb632f29e4b_2"
          ]
        }
      }
    },
    "proofHash": "705a4a67f9d4e2832e9d4b5df7676c7509ec0689aff93e187d075e8b4b7d29ab"
  },
  {
    "request": {
      "schemaVersion": 1,
      "scope": "project:c19-frozen-proof",
      "budgetId": "budget:c19-frozen-proof",
      "boardSequence": 0,
      "resources": {
        "boardSequence": 0,
        "budgetId": "budget:c19-frozen-proof",
        "limits": {
          "tokens": 100000,
          "calls": 4,
          "steps": 4
        },
        "occupied": {
          "tokens": 0,
          "calls": 0,
          "steps": 0
        },
        "available": {
          "tokens": 100000,
          "calls": 4,
          "steps": 4
        },
        "status": "available",
        "holdReason": null
      },
      "configuration": {
        "schemaVersion": 1,
        "configurationRef": "configuration:frozen-original",
        "authorizationRef": "authorization:frozen-original",
        "allowance": {
          "schemaVersion": 2,
          "unit": "total_model_tokens",
          "maxTokens": 100000,
          "maxCalls": 4,
          "maxSteps": 4,
          "maxPromptChars": 100000
        }
      },
      "stateRef": "state:frozen-original",
      "state": {
        "schemaVersion": 1,
        "scope": "project:c19-frozen-proof",
        "intents": [],
        "completed": [],
        "running": [],
        "materials": [],
        "consumedSourceRefs": []
      },
      "opportunities": [],
      "organization": [],
      "materials": [
        {
          "ref": "source:frozen-original",
          "kind": "source",
          "text": "{\"description\":\"Actual archived public source.\",\"nested\":{\"readRef\":\"source:frozen-legacy-address\"}}",
          "sourceRefs": [
            "source:frozen-original"
          ]
        }
      ],
      "operation": {
        "kind": "think",
        "operationId": "operation:frozen-v3",
        "purpose": "Choose a source-bound next read.",
        "expectedChange": "Resolve original public source.",
        "sourceRefs": [
          "source:frozen-original"
        ]
      }
    },
    "output": {
      "schemaVersion": 1,
      "intents": [],
      "publicExplanation": "Read the original before changing a purpose.",
      "sourceRefs": [
        "source:frozen-original"
      ],
      "agendaRead": {
        "kind": "read",
        "operationId": "central-change-inspection:3529898bc6fd60960a8df34fdb01e49e8362b08ea19c05ef84ea4ef2e3bda47e",
        "purpose": "Open the original.",
        "expectedChange": "Obtain delivered original text.",
        "sourceRefs": [
          "source:frozen-original"
        ],
        "refs": [
          "source:frozen-original"
        ],
        "maximumChars": 1024
      }
    },
    "proof": {
      "schemaVersion": 1,
      "type": "central_deliberation_wire_evidence",
      "projectionVersion": "central-learning-change-v1",
      "inputVersion": "central-learning-change-input-v3",
      "checkpoint": "central-input-checkpoint:585bf1f716f4f1b9f15f11cbf2797d67643366d7a6c7cbf5290ca29c2f5327f4",
      "requestHash": "585bf1f716f4f1b9f15f11cbf2797d67643366d7a6c7cbf5290ca29c2f5327f4",
      "dictionaryHash": "3c5ffe4000812fd095dda3d2a18f46a6c7fda5bda94eeedddf30345ed128bee2",
      "viewHash": "546efef467372763db259b738fd9c0fc0753c5e414bf24a05e8ec711db2ee225",
      "exposure": [
        {
          "ref": "source:frozen-original",
          "kind": "body",
          "textHash": "1e023d4d4a5b8135ea30a04ab04ed3487da46079cfa2ed3598abd4babb90ad81",
          "readRefs": [
            "source:frozen-original"
          ]
        }
      ],
      "messagesHash": "eb00770a300bb3595d44148aa78e6a36b3985224a796f872243ccd1383ef59f3",
      "toolsHash": "cac0c8eded00e194ce259d7c820ca2effc26a7cc4d5c0d312efab244a32300e7",
      "responseSchemaHash": null,
      "maxOutputTokens": 8192,
      "outputHash": "c7ff1ed492590f15ee4095fc9df1a2e41df6a7fb3b7b8480ed57a6587f2d3f5f",
      "format": {
        "kind": "tool",
        "description": "Return only this public learning change."
      },
      "fundingMessage": {
        "role": "user",
        "content": "{\"available\":{\"calls\":3,\"steps\":3,\"tokens\":80000},\"budgetId\":\"budget:c19-frozen-proof\",\"holdReason\":null,\"interpretation\":\"current_root_resources_not_new_authorization_or_value_prediction\",\"limits\":{\"calls\":4,\"steps\":4,\"tokens\":100000},\"occupied\":{\"calls\":1,\"steps\":1,\"tokens\":20000},\"role\":\"host_original_root_after_this_computation_reservation\",\"status\":\"available\",\"thisComputation\":{\"calls\":1,\"maxTokens\":20000,\"reservationId\":\"central-deliberation:f760146da08bf63fca7efe69880e8a687c5e4baf968e2d7943896d0a5ff231a6\",\"steps\":1}}"
      },
      "rawChange": {
        "checkpoint": "central-input-checkpoint:585bf1f716f4f1b9f15f11cbf2797d67643366d7a6c7cbf5290ca29c2f5327f4",
        "changes": [],
        "explanation": "Read the original before changing a purpose.",
        "sources": [
          "b585bf1f716f4_2"
        ],
        "inspect": {
          "purpose": "Open the original.",
          "expectedChange": "Obtain delivered original text.",
          "refs": [
            "r585bf1f716f4_3"
          ],
          "maximumChars": 1024,
          "sources": [
            "b585bf1f716f4_2"
          ]
        }
      }
    },
    "proofHash": "49c7668b6563e2eb98b0bf3e70fa11ac7a7d0d0f1f261f46d58b6317f831bbb7"
  }
] as const;

test("v4 cold reader preserves frozen C18 v1/v2/v3 public wire proofs without rewriting their original contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-c19-frozen-proof-"));
  try {
    const first = FROZEN_C18[0], options = { boardRoot: root, scope: first.request.scope,
      budgetId: first.request.budgetId, enabled: () => true };
    const store = createCentralDeliberationReceiptsAtRoot(options), saved: CentralDeliberationDelivery[] = [];

    for (const fixture of FROZEN_C18) {
      assert.equal(contentHashOf(fixture.proof), fixture.proofHash, "expected bytes came from the frozen renderer");
      assert.ok(isCentralDeliberationWireEvidence(fixture.proof, fixture.request, fixture.output));
      saved.push(await store.save({ request: fixture.request, output: fixture.output, wireEvidence: fixture.proof }));
      assert.equal(isCentralDeliberationWireEvidence({ ...fixture.proof,
        inputVersion: "central-learning-change-input-v4" }, fixture.request, fixture.output), false,
      "a historical full checkpoint cannot be relabeled as a new short-selection proof");
    }

    const board = createRewardV2BoardPort(root, () => true), prefix = await board.read();
    const cold = createCentralDeliberationReceiptsAtRoot(options);

    for (const [index, fixture] of FROZEN_C18.entries()) {
      const read = await cold.read(fixture.request.operation.operationId);
      assert.ok(read);
      assert.deepEqual(read, saved[index]);
      assert.deepEqual(read.wireEvidence, fixture.proof);
      assert.equal(Object.hasOwn(read.request.configuration, "generationLimits"), false);
      assert.equal(Object.hasOwn(read.request.operation, "maxOutputTokens"), false);
      assert.equal(read.wireEvidence!.maxOutputTokens, 8192);
    }

    assert.deepEqual(readCentralDeliberationDeliveriesFromFacts(prefix.facts, first.request.scope, prefix.revision,
      saved.map(row => row.deliveryRef)), saved);
    assert.deepEqual(await board.read(), prefix, "cold reconstruction appends or rewrites no historical facts");
    assert.deepEqual(FROZEN_C18[0].output.agendaRead.refs, ["source:frozen-legacy-address"]);
    assert.deepEqual(FROZEN_C18[1].output.agendaRead.refs, ["source:frozen-original"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
