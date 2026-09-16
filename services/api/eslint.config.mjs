// @ts-check
import { byondBase } from '@byond/config/eslint/base';

// Node globals (process, console, ...) everywhere; Jest globals
// (describe, it, expect, jest, ...) so spec files lint cleanly even for
// rules that fall back to no-undef semantics.
export default byondBase({ node: true, jest: true });
