import { describe, it, expect } from "vitest";
import { chunkCSharpFile, computeContentHash, findBraceRange, MAX_CHUNK_CHARS, MAX_FILE_SIZE } from "./chunker.js";

// ---------------------------------------------------------------------------
// Sample C# source strings
// ---------------------------------------------------------------------------

const simpleCSharp = `using UnityEngine;

namespace Game.Combat
{
    public class DamageSystem : SystemBase
    {
        private readonly ICombatService _combat;

        public DamageSystem(ICombatService combat)
        {
            _combat = combat;
        }

        public override void OnUpdate(float dt)
        {
            // Apply damage
        }
    }
}`;

// A class whose total body text exceeds MAX_CHUNK_CHARS (1500 chars).
// We pad it with extra methods to guarantee the threshold is crossed.
const largeCSharp = `using UnityEngine;
using System.Collections.Generic;

namespace Game.AI
{
    public class EnemyController : MonoBehaviour
    {
        private float _health = 100f;
        private float _speed = 5f;
        private bool _isAlive = true;
        private List<Transform> _waypoints = new List<Transform>();

        public void Initialize(float health, float speed)
        {
            _health = health;
            _speed = speed;
            _isAlive = true;
        }

        public void TakeDamage(float amount)
        {
            if (!_isAlive) return;
            _health -= amount;
            if (_health <= 0f)
            {
                Die();
            }
        }

        public void MoveTo(Vector3 target)
        {
            // Move toward target position at _speed units per second
            var direction = (target - transform.position).normalized;
            transform.position += direction * _speed * Time.deltaTime;
        }

        public void Patrol()
        {
            // Cycle through waypoints in sequence
            foreach (var waypoint in _waypoints)
            {
                MoveTo(waypoint.position);
            }
        }

        private void Die()
        {
            _isAlive = false;
            // Trigger death animation, drop loot, etc.
            gameObject.SetActive(false);
        }

        public bool IsAlive()
        {
            return _isAlive;
        }

        public float GetHealthPercent()
        {
            return _health / 100f;
        }

        public void SetWaypoints(List<Transform> waypoints)
        {
            _waypoints = waypoints ?? new List<Transform>();
        }

        public override string ToString()
        {
            return $"EnemyController(health={_health}, alive={_isAlive})";
        }
    }
}`;

const structCSharp = `using Strada.Core.ECS;

namespace Game.Components
{
    public readonly struct HealthComponent : IComponent
    {
        public readonly float Value;
        public readonly float MaxValue;

        public HealthComponent(float value, float maxValue)
        {
            Value = value;
            MaxValue = maxValue;
        }
    }
}`;

const usingsOnlyCSharp = `using System;
using System.Collections.Generic;
using UnityEngine;
`;

const nestedBracesCSharp = `using System;

namespace Demo
{
    public class Parser
    {
        public string ExtractBlock(string input)
        {
            // This comment has { braces } that should not confuse the parser
            string template = "{ key: \\"value\\" }";
            string verbatim = @"line1
line2 { still in string }
line3";
            char open = '{';
            char close = '}';
            return template + verbatim;
        }
    }
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function totalContentLength(csharp: string): number {
  // Quick sanity: measure what the large class body would be
  const idx = csharp.indexOf("public class");
  return idx === -1 ? 0 : csharp.length - idx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chunkCSharpFile", () => {
  it("chunks a simple file with one class containing methods → file_header + class chunk", () => {
    const chunks = chunkCSharpFile("Assets/Combat/DamageSystem.cs", simpleCSharp);

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const header = chunks.find((c) => c.kind === "file_header");
    expect(header).toBeDefined();
    expect(header!.startLine).toBe(1);
    expect(header!.content).toContain("using UnityEngine");

    const classChunk = chunks.find((c) => c.kind === "class");
    expect(classChunk).toBeDefined();
    expect(classChunk!.symbol).toBe("DamageSystem");
    expect(classChunk!.namespace).toBe("Game.Combat");
    expect(classChunk!.content).toContain("public class DamageSystem");
  });

  it("chunks a large class (>1500 chars) → file_header + method/constructor chunks, no single class chunk", () => {
    const chunks = chunkCSharpFile("Assets/AI/EnemyController.cs", largeCSharp);

    // The class body must be large enough to trigger splitting
    const classOnlyChunk = chunks.find((c) => c.kind === "class" && c.symbol === "EnemyController");
    expect(classOnlyChunk).toBeUndefined();

    const header = chunks.find((c) => c.kind === "file_header");
    expect(header).toBeDefined();

    const methodChunks = chunks.filter((c) => c.kind === "method");
    expect(methodChunks.length).toBeGreaterThan(0);

    // Each method chunk must carry the context header
    for (const mc of methodChunks) {
      expect(mc.content).toContain("// File: Assets/AI/EnemyController.cs");
      expect(mc.content).toContain("// Class: EnemyController");
      expect(mc.parentSymbol).toBe("EnemyController");
      expect(mc.namespace).toBe("Game.AI");
    }

    // Verify specific methods are present
    const methodNames = methodChunks.map((c) => c.symbol);
    expect(methodNames).toContain("TakeDamage");
    expect(methodNames).toContain("MoveTo");
  });

  it("chunks a struct implementing IComponent → struct chunk with correct kind", () => {
    const chunks = chunkCSharpFile("Assets/Components/HealthComponent.cs", structCSharp);

    const structChunk = chunks.find((c) => c.kind === "struct");
    expect(structChunk).toBeDefined();
    expect(structChunk!.symbol).toBe("HealthComponent");
    expect(structChunk!.namespace).toBe("Game.Components");
    expect(structChunk!.content).toContain("public readonly struct HealthComponent");
    expect(structChunk!.content).toContain("IComponent");
    expect(structChunk!.startLine).toBeGreaterThan(0);
    expect(structChunk!.endLine).toBeGreaterThanOrEqual(structChunk!.startLine);
  });

  it("handles an empty file → returns empty array", () => {
    const chunks = chunkCSharpFile("Empty.cs", "");
    expect(chunks).toHaveLength(0);
  });

  it("handles a whitespace-only file → returns empty array", () => {
    const chunks = chunkCSharpFile("Blank.cs", "   \n\n  \t\n");
    expect(chunks).toHaveLength(0);
  });

  it("handles a file with only using statements → produces a file_header chunk", () => {
    const chunks = chunkCSharpFile("Usings.cs", usingsOnlyCSharp);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const header = chunks.find((c) => c.kind === "file_header");
    expect(header).toBeDefined();
    expect(header!.content).toContain("using System;");
    expect(header!.content).toContain("using UnityEngine;");
    expect(header!.startLine).toBe(1);
  });

  it("chunk IDs are deterministic", () => {
    const path = "Assets/Combat/DamageSystem.cs";
    const chunks1 = chunkCSharpFile(path, simpleCSharp);
    const chunks2 = chunkCSharpFile(path, simpleCSharp);

    expect(chunks1.map((c) => c.id)).toEqual(chunks2.map((c) => c.id));
  });

  it("chunk IDs differ when file path differs", () => {
    const chunks1 = chunkCSharpFile("PathA/DamageSystem.cs", simpleCSharp);
    const chunks2 = chunkCSharpFile("PathB/DamageSystem.cs", simpleCSharp);

    const ids1 = new Set(chunks1.map((c) => c.id));
    const ids2 = new Set(chunks2.map((c) => c.id));
    // At least some IDs must differ (they encode the file path)
    const intersection = [...ids1].filter((id) => ids2.has(id));
    expect(intersection.length).toBe(0);
  });

  it("content hashes are deterministic", () => {
    const path = "Assets/Combat/DamageSystem.cs";
    const chunks1 = chunkCSharpFile(path, simpleCSharp);
    const chunks2 = chunkCSharpFile(path, simpleCSharp);

    for (let i = 0; i < chunks1.length; i++) {
      expect(chunks1[i]!.contentHash).toBe(chunks2[i]!.contentHash);
    }
  });

  it("nested braces in strings and comments don't break brace matching", () => {
    const chunks = chunkCSharpFile("Demo/Parser.cs", nestedBracesCSharp);

    // Should produce a file_header and at least one class chunk (or method chunks)
    expect(chunks.length).toBeGreaterThan(0);

    const classOrMethodChunks = chunks.filter(
      (c) => c.kind === "class" || c.kind === "method"
    );
    expect(classOrMethodChunks.length).toBeGreaterThan(0);

    // The ExtractBlock method chunk must be well-formed (start < end)
    for (const chunk of classOrMethodChunks) {
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it("returns empty array for file exceeding MAX_FILE_SIZE", () => {
    const huge = "x".repeat(MAX_FILE_SIZE + 1);
    const chunks = chunkCSharpFile("Huge.cs", huge);
    expect(chunks).toHaveLength(0);
  });

  it("each chunk has an id of exactly 16 hex characters", () => {
    const chunks = chunkCSharpFile("Assets/Combat/DamageSystem.cs", simpleCSharp);
    for (const chunk of chunks) {
      expect(chunk.id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("each chunk has a contentHash of exactly 16 hex characters", () => {
    const chunks = chunkCSharpFile("Assets/Combat/DamageSystem.cs", simpleCSharp);
    for (const chunk of chunks) {
      expect(chunk.contentHash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("all chunks have a valid indexedAt timestamp (number in ms)", () => {
    const chunks = chunkCSharpFile("Assets/Combat/DamageSystem.cs", simpleCSharp);
    const now = Date.now();
    for (const chunk of chunks) {
      expect(typeof chunk.indexedAt).toBe("number");
      expect(chunk.indexedAt).toBeGreaterThan(0);
      // Should be a reasonable timestamp (within last hour for this test)
      expect(chunk.indexedAt).toBeLessThanOrEqual(now);
    }
  });

  it("startLine and endLine are 1-based and endLine >= startLine for all chunks", () => {
    const allSources = [simpleCSharp, largeCSharp, structCSharp, nestedBracesCSharp];
    for (const src of allSources) {
      const chunks = chunkCSharpFile("Test.cs", src);
      for (const chunk of chunks) {
        expect(chunk.startLine).toBeGreaterThanOrEqual(1);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// findBraceRange unit tests
// ---------------------------------------------------------------------------

describe("findBraceRange", () => {
  it("returns start and end line for a simple block", () => {
    const code = `class Foo\n{\n    void Bar() {}\n}\n`;
    // Class declaration is on line 1; opening brace on line 2; closing on line 4
    const result = findBraceRange(code, 1);
    expect(result).not.toBeNull();
    expect(result!.startLine).toBe(2);
    expect(result!.endLine).toBe(4);
  });

  it("returns null for a semicolon-terminated declaration", () => {
    const code = `public abstract void Foo();\n`;
    const result = findBraceRange(code, 1);
    expect(result).toBeNull();
  });

  it("correctly handles nested braces", () => {
    const code = `void Outer()\n{\n    if (true)\n    {\n        int x = 1;\n    }\n}\n`;
    const result = findBraceRange(code, 1);
    expect(result).not.toBeNull();
    expect(result!.endLine).toBe(7);
  });

  it("ignores braces inside double-quoted string literals", () => {
    const code = `void Foo()\n{\n    string s = "{ not a brace }";\n}\n`;
    const result = findBraceRange(code, 1);
    expect(result).not.toBeNull();
    expect(result!.endLine).toBe(4);
  });

  it("ignores braces inside single-line comments", () => {
    const code = `void Foo()\n{\n    // { fake open\n    int x = 1;\n}\n`;
    const result = findBraceRange(code, 1);
    expect(result).not.toBeNull();
    expect(result!.endLine).toBe(5);
  });

  it("ignores braces inside block comments", () => {
    const code = `void Foo()\n{\n    /* { fake } */\n    int x = 1;\n}\n`;
    const result = findBraceRange(code, 1);
    expect(result).not.toBeNull();
    expect(result!.endLine).toBe(5);
  });

  it("ignores braces inside verbatim string literals", () => {
    const code = `void Foo()\n{\n    string s = @"{\nstill in string\n}";\n    int x = 1;\n}\n`;
    const result = findBraceRange(code, 1);
    expect(result).not.toBeNull();
    // The verbatim string spans multiple lines, so the closing } of the method
    // is wherever the real depth returns to 0.
    expect(result!.endLine).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// computeContentHash unit tests
// ---------------------------------------------------------------------------

describe("computeContentHash", () => {
  it("returns a 16-character hex string", () => {
    const hash = computeContentHash("hello world");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", () => {
    const h1 = computeContentHash("same content");
    const h2 = computeContentHash("same content");
    expect(h1).toBe(h2);
  });

  it("differs for different content", () => {
    const h1 = computeContentHash("content A");
    const h2 = computeContentHash("content B");
    expect(h1).not.toBe(h2);
  });

  it("handles empty string", () => {
    const hash = computeContentHash("");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
