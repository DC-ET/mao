export class PromptQueue {
  private readonly items: string[] = [];

  push(text: string): number {
    const t = text.trim();
    if (!t) return this.items.length;
    this.items.push(t);
    return this.items.length;
  }

  shift(): string | undefined {
    return this.items.shift();
  }

  clear(): void {
    this.items.length = 0;
  }

  list(): string[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }
}
