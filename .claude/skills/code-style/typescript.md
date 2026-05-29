# TypeScript/JavaScript Code Style

## Comments

- Use `/* ... */` comments for classes and methods.
- Use `//` inside functions, placed above the line.
- Start all comments with a capital letter and end with a dot.
- Create comments for exported methods — keep them short and precise.
- Start method/function comments with a verb.
- Do not repeat in comments what is already in the method name.
- Skip comments for trivial self-explanatory methods.

## Code Patterns

- Prefer getters over `getValue()` functions
- Use destructuring: `const {x} = value` instead of `const x = value.x`
- Use imports only on top of the files. Avoid `await import` pattern
- Order class members as: `field`, `constructor`, `public-method`, `private-method`
- Use getMessageFromError to extract error messages in catch clauses

## Type Safety

- Always specify explicit function return types
- Always specify explicit module boundary types
- **NEVER use non-null assertions (`!`)** - use optional chaining (`?.`), nullish coalescing (`??`), filtering, or
  `assertTruthy()` instead
- Avoid empty object types
- Avoid wrapper object types
- Avoid `any` types, prefer specific types or unknown

## Code Quality

- No unused imports
- No unused variables (prefix with `_` if intentionally unused)
- No unreachable code
- Always use strict equality (`===` and `!==`)

## Formatting

- Single quotes for strings
- Trailing commas in arrays and objects
- Arrow functions: avoid parentheses when possible (`x => x`)
- Max line width: 120 characters
- Imports are auto-organized by Prettier

## Linter

- Never disable linter rules
- After coding phase is finished check linter. Run it for the modified package only.

## Logging

- Use a class-level `lp` field for the class name prefix: `private readonly lp = 'ClassName';`
- In each method that logs, create a local `lp` variable: `const lp = \`${this.lp}.methodName:\`;`
- Use the local `lp` for all log messages in that method: `console.log(\`${lp} Message\`);`


