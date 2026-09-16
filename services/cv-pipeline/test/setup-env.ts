// Decorator metadata must exist before any module carrying class-validator
// decorators is imported, or plainToInstance has nothing to read.
import 'reflect-metadata';

/**
 * Test environment. The values are syntactically valid and obviously
 * fake: configuration validation must have something to accept, and
 * SECURITY.md forbids anything that could be mistaken for a real
 * credential in a fixture.
 */
process.env.NODE_ENV = 'test';
process.env.CV_PIPELINE_API_BASE_URL ??= 'http://127.0.0.1:3000';
process.env.CV_PIPELINE_API_TOKEN ??= 'test-token-not-a-real-credential';
