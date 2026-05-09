export interface GraphNode {
  id: string;
  label: string;
  kind: string | null;
  color: string;
  val: number;
  file: string | null;
  line: number | null;
  x?: number;
  y?: number;
}

export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  label?: string;
}
