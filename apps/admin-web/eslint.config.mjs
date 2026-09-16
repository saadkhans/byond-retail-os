// @ts-check
import { byondReact } from '@byond/config/eslint/react';

// Browser globals for the app itself; Node globals because a few unit
// specs read fixture files off disk. Vite's build output is ignored by
// the shared base.
export default byondReact();
