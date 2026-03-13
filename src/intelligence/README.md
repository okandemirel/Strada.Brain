# src/intelligence/

Static analysis tooling for C# codebases, specifically targeting Unity projects built on the Strada.Core framework.

## Regex-Based C# Parser (`csharp-parser.ts`)

A lightweight, regex-based structural extractor for C# files. Used by `strada-analyzer.ts`.

- Rejects files over 1MB to prevent ReDoS
- Extracts namespaces (block and file-scoped), usings, classes, structs, methods, fields, properties, attributes, and constructors via independent regex passes
- Distinguishes base classes from interfaces using an `I`-prefix heuristic
- Detects generic arguments, modifiers (`abstract`, `partial`, `static`, etc.), and `readonly` structs
- Identifies DI dependencies in constructors by filtering for `I`-prefixed parameter types
- Property extraction differentiates getters, setters, and `init` accessors
- Helper functions: `inheritsFrom()`, `implementsInterface()`, `stripGenericArgs()`
- Returns a `CSharpFileInfo` struct containing all extracted declarations

## Deep C# Parser (`csharp-deep-parser.ts`)

A tokenizer + recursive-descent parser that replaces the regex approach with a proper lexer/parser pipeline. Used by `code-quality.ts`.

- Two-phase architecture: `tokenize()` produces a `Token[]` with 20 token kinds, then `Parser` class consumes them via recursive descent
- Tokenizer handles single-line comments, multi-line comments, verbatim strings (`@""`), character literals, and preprocessor directives (all skipped/consumed correctly)
- Parser produces a typed AST (`CSharpAST`) containing `UsingDirective`, `NamespaceDecl`, and `TypeDecl` nodes
- Type declarations: `ClassDecl`, `StructDecl`, `InterfaceDecl`, `EnumDecl` -- each with modifiers, generic params, base types, members, and attributes
- Member declarations: `MethodDecl`, `PropertyDecl`, `FieldDecl`, `ConstructorDecl`, `EventDecl`
- Tracks `bodyLineCount` on methods and constructors for complexity analysis
- Handles nested generics via depth-counted `<`/`>` parsing with heuristic bailout on `;` or `{`
- Supports nested types, expression-bodied members (`=>`), `where` constraints, and `record` types
- Query utilities: `flattenTypes()`, `getClasses()`, `getStructs()`, `getInterfaces()`, `getEnums()`, `getMethods()`, `getConstructors()`, `getFields()`, `getProperties()`, `getDependencies()`
- Inheritance/interface checks: `deepInheritsFrom()`, `deepImplements()` (generic-aware via stripping `<...>`)
- 1MB file size cap

## Strada Project Analyzer (`strada-analyzer.ts`)

Scans an entire Unity/Strada.Core project directory and extracts framework-specific architecture information. Uses the regex parser.

- `StradaAnalyzer` class takes a project path, globs for `**/*.cs` (excluding `node_modules`, `Library`, `Temp`), and parses each file
- Identifies Strada framework constructs:
  - **Modules**: classes inheriting from `ModuleConfig`
  - **Systems**: non-abstract classes inheriting from `SystemBase`, `JobSystemBase`, or `SystemGroup`
  - **Components**: structs implementing `IComponent`
  - **Services**: classes implementing `I`-prefixed interfaces (DI registrations)
  - **Mediators**: classes inheriting from `EntityMediator<T>`, extracting the view type from the generic argument
  - **Controllers**: classes inheriting from `Controller<T>`, extracting the model type
- Event bus analysis: scans for `.Publish<T>`, `.Subscribe<T>`, and `.Send<T>` calls with line-level tracking
- Builds a `DependencyEdge[]` graph with four edge types: `inherits`, `implements`, `injects`, `uses_event`
- Deduplicates edges via a `Set<string>` keyed by `from->to:type`
- `formatAnalysis()` static method renders the full analysis as a plain-text report

## Code Quality Analyzer (`code-quality.ts`)

Detects anti-patterns, computes per-file quality scores (0-100), and generates refactoring suggestions. Uses the deep parser.

- `analyzeFile()` runs nine rule checks against a single file's deep AST
- `analyzeProject()` globs for `**/*.cs`, skips files over 1MB, and aggregates per-file reports
- Scoring: each issue carries a severity penalty (error=10, warning=4, info=1); file score = `max(0, 100 - totalPenalty)`
- Project score is the arithmetic mean of all file scores

### Rules

| Rule | Severity | Category | Detection |
|------|----------|----------|-----------|
| `god-class-methods` | warning | anti-pattern | Class with >20 methods |
| `god-class-fields` | warning | anti-pattern | Class with >15 fields/properties |
| `long-method` | warning | complexity | Method body >50 lines |
| `too-many-params` | info | complexity | Method with >5 parameters |
| `too-many-dependencies` | warning | anti-pattern | Constructor with >6 parameters (DI overload) |
| `many-base-types` | info | complexity | Class with >3 base types |
| `empty-catch` | warning | anti-pattern | `catch { }` blocks (regex on raw content) |
| `magic-number` | info | anti-pattern | Numeric literals outside allowed set (0, 1, 2, -1, 100, float equivalents); capped at 3 reports per file |
| `class-naming` | warning | naming | Class name not PascalCase |
| `private-field-prefix` | info | naming | Private non-const non-static field missing `_` prefix |
| `component-reference-type` | error | strada-specific | `IComponent` struct with reference-type fields (`string`, `List`, `Dictionary`, `Array`, `Action`, `Func`, `object`) |
| `system-no-query` | info | strada-specific | `SystemBase`/`JobSystemBase` subclass with no `EntityQuery`/`CreateQuery`/`World.Get` usage |
| `module-too-many-systems` | warning | strada-specific | `ModuleConfig` with >10 `AddSystem`/`RegisterSystem` calls |
| `service-no-interface` | info | strada-specific | `*Service` class with no `I`-prefixed interface |
| `multiple-classes-per-file` | info | architecture | More than one top-level class per file |
| `fat-interface` | info | architecture | Interface with >10 members |

- `formatQualityReport()` renders the project report as plain text with severity icons (`!!`, `!`, `i`), worst-file list, and category breakdown

## Key Files

| File | Purpose |
|------|---------|
| `csharp-parser.ts` | Regex-based C# structural extractor (classes, structs, methods, fields, constructors, DI dependencies) |
| `csharp-deep-parser.ts` | Tokenizer + recursive-descent C# parser producing a typed AST with nested type/generic support |
| `strada-analyzer.ts` | Project-wide Strada.Core framework analysis (modules, systems, components, services, mediators, controllers, events, dependency graph) |
| `code-quality.ts` | Quality scoring engine with 16 rules across 5 categories (anti-pattern, complexity, naming, strada-specific, architecture) |
