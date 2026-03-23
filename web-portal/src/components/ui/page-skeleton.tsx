import { Skeleton } from './skeleton'

export function PageSkeleton({ rows = 5, grid = false }: { rows?: number; grid?: boolean }) {
  return (
    <div className="h-full overflow-y-auto p-7 w-full">
      <Skeleton className="h-7 w-48 mb-6" />
      <Skeleton className="h-4 w-64 mb-4" />
      {grid ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      ) : (
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
        </div>
      )}
    </div>
  )
}
