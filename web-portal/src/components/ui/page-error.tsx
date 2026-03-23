export function PageError({ title, message }: { title: string; message: string }) {
  return (
    <div className="h-full overflow-y-auto p-7 w-full">
      <div className="flex flex-col items-center justify-center h-[200px] gap-3 text-text-secondary">
        <div className="text-4xl">&#9888;</div>
        <h3 className="text-text text-lg font-semibold">{title}</h3>
        <p className="text-sm max-w-[400px] text-center">{message}</p>
      </div>
    </div>
  )
}
