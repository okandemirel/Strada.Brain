---
name: security-review
description: Use when adding authentication, handling user input, working with secrets, creating API endpoints, or implementing sensitive features. Provides comprehensive security checklist and patterns.
origin: Everything Claude Code (ECC)
---

# Security Review Skill

Comprehensive security checklist and patterns for Strada.Brain development.

## When to Activate

- Implementing authentication or authorization
- Handling user input or file uploads
- Creating new API endpoints
- Working with secrets or credentials
- Implementing payment features
- Storing or transmitting sensitive data
- Integrating third-party APIs

## Security Checklist

### 1. Secrets Management

#### ❌ NEVER Do This
```typescript
const apiKey = "sk-proj-xxxxx"  // Hardcoded secret
const dbPassword = "password123" // In source code
```

#### ✅ ALWAYS Do This
```typescript
const apiKey = process.env.ANTHROPIC_API_KEY;
const dbUrl = process.env.DATABASE_URL;

// Verify secrets exist
if (!apiKey) {
  throw new Error('ANTHROPIC_API_KEY not configured');
}
```

#### Verification Steps
- [ ] No hardcoded API keys, tokens, or passwords
- [ ] All secrets in environment variables
- [ ] `.env.local` in .gitignore
- [ ] No secrets in git history
- [ ] Production secrets in secure vault

### 2. Input Validation

#### Always Validate User Input
```typescript
import { z } from 'zod';

// Define validation schema
const CreateToolSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  config: z.record(z.unknown())
});

// Validate before processing
export async function createTool(input: unknown) {
  try {
    const validated = CreateToolSchema.parse(input);
    return await toolRegistry.create(validated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, errors: error.errors };
    }
    throw error;
  }
}
```

#### Path Validation (Critical for File Tools)
```typescript
function validatePath(userPath: string, allowedBase: string): string {
  // Resolve to absolute path
  const resolved = path.resolve(allowedBase, userPath);
  
  // Ensure path is within allowed base
  if (!resolved.startsWith(path.resolve(allowedBase))) {
    throw new Error('Path traversal detected');
  }
  
  return resolved;
}
```

#### File Upload Validation
```typescript
function validateFileUpload(file: File) {
  // Size check (5MB max)
  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    throw new Error('File too large (max 5MB)');
  }

  // Type check
  const allowedTypes = ['image/jpeg', 'image/png', 'application/json'];
  if (!allowedTypes.includes(file.type)) {
    throw new Error('Invalid file type');
  }

  return true;
}
```

#### Verification Steps
- [ ] All user inputs validated with schemas
- [ ] File uploads restricted (size, type)
- [ ] Paths validated and sanitized
- [ ] No direct use of user input in shell commands
- [ ] Whitelist validation (not blacklist)
- [ ] Error messages don't leak sensitive info

### 3. Command Injection Prevention

#### ❌ NEVER Concatenate Commands
```typescript
// DANGEROUS - Command injection vulnerability
const command = `git clone ${userUrl}`;
exec(command);
```

#### ✅ ALWAYS Use Parameterized Commands
```typescript
// Safe - use arrays for arguments
import { execFile } from 'child_process';

execFile('git', ['clone', userUrl], (error, stdout) => {
  // Handle result
});
```

### 4. Authentication & Authorization

#### Token Handling
```typescript
// Store in secure httpOnly cookies
res.setHeader('Set-Cookie',
  `token=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`);
```

#### Authorization Checks
```typescript
export async function deleteTool(toolId: string, requesterId: string) {
  // ALWAYS verify authorization first
  const requester = await authService.getUser(requesterId);

  if (requester.role !== 'admin') {
    return {
      success: false,
      error: 'Unauthorized'
    };
  }

  // Proceed with deletion
  await toolRegistry.delete(toolId);
}
```

#### Verification Steps
- [ ] Tokens stored in httpOnly cookies
- [ ] Authorization checks before sensitive operations
- [ ] Role-based access control implemented
- [ ] Session management secure

### 5. XSS Prevention

#### Sanitize HTML
```typescript
import DOMPurify from 'isomorphic-dompurify';

// ALWAYS sanitize user-provided HTML
function renderUserContent(html: string) {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'p', 'code'],
    ALLOWED_ATTR: []
  });
  return clean;
}
```

### 6. Rate Limiting

#### API Rate Limiting
```typescript
import { RateLimiter } from '@/lib/security';

const limiter = new RateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: 'Too many requests'
});

// Apply to routes
app.use('/api/', limiter.middleware);
```

#### Budget Tracking (Strada.Brain Specific)
```typescript
// Track tool usage budget
const budget = session.getBudget();
if (budget.remaining < 5) {
  return {
    needsConfirmation: true,
    reason: 'Budget limit approaching'
  };
}
```

### 7. Sensitive Data Exposure

#### Logging
```typescript
// ❌ WRONG: Logging sensitive data
logger.info('User login:', { email, password });

// ✅ CORRECT: Redact sensitive data
logger.info('User login:', { email, userId: user.id });
```

#### Error Messages
```typescript
// ❌ WRONG: Exposing internal details
catch (error) {
  return {
    error: error.message,
    stack: error.stack
  };
}

// ✅ CORRECT: Generic error messages
catch (error) {
  logger.error('Internal error:', error);
  return {
    error: 'An error occurred. Please try again.'
  };
}
```

### 8. Dependency Security

#### Regular Updates
```bash
# Check for vulnerabilities
npm audit

# Fix automatically fixable issues
npm audit fix

# Update dependencies
npm update

# Check for outdated packages
npm outdated
```

## Security Testing

### Automated Security Tests
```typescript
// Test authentication
 test('requires authentication', async () => {
   const response = await fetch('/api/protected');
   expect(response.status).toBe(401);
 });

// Test authorization
 test('requires admin role', async () => {
   const response = await fetch('/api/admin', {
     headers: { Authorization: `Bearer ${userToken}` }
   });
   expect(response.status).toBe(403);
 });

// Test input validation
 test('rejects invalid input', async () => {
   const response = await fetch('/api/tools', {
     method: 'POST',
     body: JSON.stringify({ name: '' })
   });
   expect(response.status).toBe(400);
 });
```

## Strada.Brain Specific Security

### Secret Sanitization
```typescript
import { SecretSanitizer } from '@/security';

const sanitizer = new SecretSanitizer();

// Automatically applied to all tool outputs
const sanitized = sanitizer.sanitize(toolOutput);
```

### Path Guard
```typescript
import { PathGuard } from '@/security';

const guard = new PathGuard({
  allowedPaths: ['/app/data', '/app/plugins'],
  readOnly: false
});

// Validate before file operations
guard.validatePath(userPath);
```

### DM Policy
```typescript
import { DMPolicy } from '@/security';

const policy = new DMPolicy({
  mode: 'confirm_write',
  excludedPaths: ['*.log', 'node_modules/**']
});

// Check before write operations
if (policy.needsConfirmation(filePath)) {
  await requestUserConfirmation(filePath, diff);
}
```

## Pre-Deployment Security Checklist

Before ANY production deployment:

- [ ] **Secrets**: No hardcoded secrets, all in env vars
- [ ] **Input Validation**: All user inputs validated
- [ ] **Path Traversal**: All paths validated
- [ ] **XSS**: User content sanitized
- [ ] **Authentication**: Proper token handling
- [ ] **Authorization**: Role checks in place
- [ ] **Rate Limiting**: Enabled on all endpoints
- [ ] **HTTPS**: Enforced in production
- [ ] **Security Headers**: CSP configured
- [ ] **Error Handling**: No sensitive data in errors
- [ ] **Logging**: No sensitive data logged
- [ ] **Dependencies**: Up to date, no vulnerabilities
- [ ] **CORS**: Properly configured
- [ ] **File Uploads**: Validated (size, type)

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Strada.Brain Security Docs](docs/security/security-overview.md)

---

**Remember**: Security is not optional. One vulnerability can compromise the entire platform. When in doubt, err on the side of caution.
