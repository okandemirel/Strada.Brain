# Strata.Brain Type System

This directory contains the core type definitions for Strata.Brain.

## Overview

The type system provides:

1. **Brand Types** - Type-safe identifiers (UserId, ChatId, etc.)
2. **Result Type** - Explicit error handling
3. **Option Type** - Nullable handling
4. **Vector Types** - Type-safe vector operations with dimension constraints
5. **Validation Types** - Structured validation results
6. **Utility Types** - DeepPartial, DeepReadonly, etc.

## Usage

```typescript
import { 
  UserId, 
  toUserId,
  Result, 
  ok, 
  err,
  Vector,
  createVector 
} from "@/types";

// Brand types
const userId: UserId = toUserId("user123");

// Result type for error handling
function divide(a: number, b: number): Result<number, string> {
  if (b === 0) return err("Cannot divide by zero");
  return ok(a / b);
}

// Vector with dimension safety
const vector = createVector([1, 2, 3], 3);
if (vector.kind === "ok") {
  // vector.value is Vector<3>
}
```

## Brand Types

Brand types prevent accidental mixing of different identifier types:

```typescript
function processUser(id: UserId): void;
function processChat(id: ChatId): void;

const userId = toUserId("123");
const chatId = toChatId("456");

processUser(userId); // ✓ OK
processUser(chatId); // ✗ Type error!
```

## Result Type

Use `Result<T, E>` instead of throwing exceptions:

```typescript
async function fetchData(): Promise<Result<Data, FetchError>> {
  try {
    const response = await fetch("/api/data");
    if (!response.ok) {
      return err({ code: "HTTP_ERROR", status: response.status });
    }
    return ok(await response.json());
  } catch (e) {
    return err({ code: "NETWORK_ERROR", cause: e });
  }
}
```

## File Structure

- `index.ts` - Main type exports
- `README.md` - This file

## Migration Guide

### From `Record<string, unknown>`

Before:
```typescript
interface Tool {
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>): Promise<unknown>;
}
```

After:
```typescript
interface Tool<TInput extends JsonObject> {
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput): Promise<ToolExecutionResult>;
}
```

### From `any`

Before:
```typescript
function process(data: any): any {
  return data.value;
}
```

After:
```typescript
function process<T>(data: T): T {
  return data;
}
```

### From nullable types

Before:
```typescript
function findUser(id: string): User | null {
  // ...
}
```

After:
```typescript
function findUser(id: string): Option<User> {
  // ...
}
```
