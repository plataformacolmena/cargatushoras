import { useEffect, useMemo, useState } from 'react'

interface PaginationProps {
  totalItems: number
  pageSize: number
  page: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (size: number) => void
  pageSizeOptions?: number[]
}

export function Pagination({
  totalItems,
  pageSize,
  page,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const safePage = Math.min(page, totalPages)
  const start = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1
  const end = Math.min(safePage * pageSize, totalItems)

  if (totalItems === 0) return null

  return (
    <div className="pagination">
      <div className="pagination-info">
        <span className="muted">
          Mostrando <strong>{start}</strong>–<strong>{end}</strong> de <strong>{totalItems}</strong>
        </span>
        {onPageSizeChange && (
          <label className="pagination-size">
            Por página:
            <select
              value={pageSize}
              onChange={(e) => {
                onPageSizeChange(Number(e.target.value))
                onPageChange(1)
              }}
            >
              {pageSizeOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="pagination-controls">
        <button
          className="btn-sm"
          onClick={() => onPageChange(1)}
          disabled={safePage <= 1}
          title="Primera página"
        >«</button>
        <button
          className="btn-sm"
          onClick={() => onPageChange(safePage - 1)}
          disabled={safePage <= 1}
          title="Anterior"
        >‹</button>
        <span className="pagination-current">
          {safePage} / {totalPages}
        </span>
        <button
          className="btn-sm"
          onClick={() => onPageChange(safePage + 1)}
          disabled={safePage >= totalPages}
          title="Siguiente"
        >›</button>
        <button
          className="btn-sm"
          onClick={() => onPageChange(totalPages)}
          disabled={safePage >= totalPages}
          title="Última página"
        >»</button>
      </div>
    </div>
  )
}

/** Hook utilitario: pagina un array y devuelve el slice + controles. */
export function usePagedItems<T>(items: T[], initialPageSize = 25) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(initialPageSize)
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const paged = useMemo(() => {
    const safePage = Math.min(page, totalPages)
    const start = (safePage - 1) * pageSize
    return items.slice(start, start + pageSize)
  }, [items, page, pageSize, totalPages])

  return { paged, page, setPage, pageSize, setPageSize, totalItems: items.length }
}
