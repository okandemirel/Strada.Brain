---
name: simplify
description: Simplifies and refines code for clarity, consistency, and maintainability while preserving all functionality. Focuses on recently modified code unless instructed otherwise. Use with /simplify command.
origin: Claude Code Official
---

# Code Simplification Skill

Simplifies and refines code for clarity, consistency, and maintainability while preserving exact functionality.

## When to Use

- After writing or modifying code
- Before committing changes
- When code feels unnecessarily complex
- When reviewing code for quality

## How to Use

```bash
/simplify
```

Or with specific files:
```bash
/simplify src/orchestrator.ts src/agents/*.ts
```

## Simplification Principles

### 1. Preserve Functionality
Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact.

### 2. Apply Project Standards
Follow established coding standards:

**TypeScript/Strada.Brain Standards:**
- Use ES modules with proper import sorting
- Prefer explicit types over inference for public APIs
- Use proper error handling patterns
- Follow naming conventions (`PascalCase` for classes, `camelCase` for functions)
- Prefer early returns over nested conditionals

### 3. Enhance Clarity

Simplify code structure by:
- Reducing unnecessary complexity and nesting
- Eliminating redundant code and abstractions
- Improving readability through clear variable and function names
- Consolidating related logic
- Removing unnecessary comments that describe obvious code
- **IMPORTANT**: Avoid nested ternary operators - prefer switch statements or if/else chains
- Choose clarity over brevity

### 4. Maintain Balance

Avoid over-simplification that could:
- Reduce code clarity or maintainability
- Create overly clever solutions that are hard to understand
- Combine too many concerns into single functions
- Remove helpful abstractions that improve code organization
- Prioritize "fewer lines" over readability
- Make the code harder to debug or extend

## Example Transformations

### Before (Complex Nested Logic)
```typescript
function processMessage(msg: IncomingMessage): Response {
  if (msg.type === 'text') {
    if (msg.content.length > 0) {
      if (msg.userId) {
        return handleText(msg);
      } else {
        return { error: 'No user' };
      }
    } else {
      return { error: 'Empty message' };
    }
  } else if (msg.type === 'image') {
    return handleImage(msg);
  } else {
    return { error: 'Unknown type' };
  }
}
```

### After (Early Returns)
```typescript
function processMessage(msg: IncomingMessage): Response {
  if (msg.type !== 'text' && msg.type !== 'image') {
    return { error: 'Unknown type' };
  }
  
  if (msg.type === 'image') {
    return handleImage(msg);
  }
  
  if (msg.content.length === 0) {
    return { error: 'Empty message' };
  }
  
  if (!msg.userId) {
    return { error: 'No user' };
  }
  
  return handleText(msg);
}
```

### Before (Redundant Abstraction)
```typescript
class MessageProcessor {
  private validator: MessageValidator;
  private handler: MessageHandler;
  
  constructor() {
    this.validator = new MessageValidator();
    this.handler = new MessageHandler();
  }
  
  async process(msg: Message): Promise<Result> {
    const isValid = await this.validator.validate(msg);
    if (!isValid) {
      return { success: false };
    }
    return await this.handler.handle(msg);
  }
}
```

### After (Direct and Clear)
```typescript
async function processMessage(msg: Message): Promise<Result> {
  if (!isValidMessage(msg)) {
    return { success: false };
  }
  return await handleMessage(msg);
}
```

## Process

1. **Identify** recently modified code sections
2. **Analyze** for opportunities to improve elegance and consistency
3. **Apply** project-specific best practices and coding standards
4. **Verify** all functionality remains unchanged
5. **Confirm** the refined code is simpler and more maintainable
6. **Document** only significant changes that affect understanding

## Focus Scope

Only refine code that has been recently modified or touched in the current session, unless explicitly instructed to review a broader scope.

## Integration with Strada.Brain

This skill works seamlessly with:
- **Orchestrator**: Simplifies agent loop logic
- **Tools**: Refines tool implementations
- **Channels**: Streamlines channel adapters
- **Security**: Maintains security patterns while simplifying

---

**Remember**: Simple code is maintainable code. When in doubt, prioritize readability over cleverness.
