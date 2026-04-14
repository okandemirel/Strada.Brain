import { Alpha } from './a.js';

export class Beta {
  useAlpha(): string {
    const a = new Alpha();
    return a.greet();
  }
}
