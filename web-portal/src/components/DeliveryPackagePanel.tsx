import { useTranslation } from 'react-i18next'
import { formatDurationShort } from '../utils/format'
import type { DeliveryPackageView, DeliveryPiece, DeliveryPieceState } from '../types/build-status'

/**
 * The persistent delivery package, rendered.
 *
 * The server owns the package (src/campaign/delivery-package.ts); this panel
 * computes NOTHING. Its only job is to keep the four states visibly apart —
 * a piece that failed, a piece that is missing and a piece nobody measured must
 * not render as the same grey row, and a package that does not exist says why
 * instead of rendering nothing at all.
 */

const PIECE_DOT: Record<DeliveryPieceState, string> = {
  present: 'bg-success',
  failed: 'bg-error',
  missing: 'bg-warning',
  'not-measured': 'bg-white/15',
}

const PIECE_TEXT: Record<DeliveryPieceState, string> = {
  present: 'text-text',
  failed: 'text-error',
  missing: 'text-warning',
  'not-measured': 'text-text-tertiary',
}

const ITEM_TEXT: Record<'met' | 'not-met' | 'open' | 'not-measured', string> = {
  met: 'text-text-secondary',
  'not-met': 'text-error',
  open: 'text-warning',
  'not-measured': 'text-text-tertiary',
}

function PieceRow({ p }: { p: DeliveryPiece }) {
  const { t } = useTranslation()
  return (
    <li className="py-2 border-b border-white/5 last:border-b-0" data-testid={`package-piece-${p.id}`}>
      <div className="flex items-start gap-2.5 text-sm">
        <span className={`inline-block w-2 h-2 mt-1.5 rounded-full shrink-0 ${PIECE_DOT[p.state]}`} aria-label={p.state} />
        <div className="min-w-0">
          <span className="font-semibold text-text">{p.title}</span>
          <span className={`ml-2 ${PIECE_TEXT[p.state]}`}>{p.summary}</span>
          <div className="text-[11px] text-text-tertiary mt-0.5">{p.source}</div>
          {(p.locators ?? []).map((loc) => (
            <div key={`${loc.kind}:${loc.label}`} className="text-[11px] text-text-secondary mt-0.5">
              {loc.label}: <code className="font-mono break-all">{loc.value}</code>
            </div>
          ))}
          {(p.lines ?? []).map((line) => (
            <div key={line} className="text-[11px] text-text-secondary mt-0.5 font-mono truncate">
              {line}
            </div>
          ))}
          {(p.missing ?? []).map((gap) => (
            <div key={gap} className="text-[11px] text-warning mt-0.5" data-testid="package-piece-missing">
              {t('dashboard.deliveryPackage.notMeasured')}: {gap}
            </div>
          ))}
          {(p.items ?? []).length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {(p.items ?? []).map((item, i) => (
                <li key={`${item.text}-${i}`} className={`text-[11px] ${ITEM_TEXT[item.state]}`}>
                  <span className="uppercase tracking-wide mr-1">{item.state}</span>
                  {item.text}
                  {item.cause ? <span className="text-text-tertiary"> — {item.cause}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {p.itemsOmitted ? (
            <div className="text-[11px] text-text-tertiary mt-0.5">{t('dashboard.deliveryPackage.andMore', { count: p.itemsOmitted })}</div>
          ) : null}
        </div>
      </div>
    </li>
  )
}

export default function DeliveryPackagePanel({ view, now }: { view: DeliveryPackageView; now: number }) {
  const { t } = useTranslation()
  const pkg = view.latest
  return (
    <div data-testid="delivery-package">
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="text-xs uppercase tracking-wide text-text-tertiary">{t('dashboard.deliveryPackage.title')}</span>
        {pkg && (
          <span className="text-[11px] text-text-secondary tabular-nums">
            {t('dashboard.deliveryPackage.revision', {
              revision: view.latestRevision ?? 1,
              ago: formatDurationShort(Math.max(0, now - (view.latestStoredAt ?? pkg.assembledAt))),
            })}
          </span>
        )}
      </div>

      {!pkg && (
        <p className="text-xs text-warning" data-testid="delivery-package-none">
          {t('dashboard.deliveryPackage.unavailable', { note: view.note ?? t('dashboard.deliveryPackage.noReason') })}
        </p>
      )}

      {pkg && (
        <div className="flex flex-col gap-2">
          <div className="text-xs text-text-secondary">
            <span className="font-mono text-text">{pkg.campaignId}</span>
            {pkg.taskId ? <span className="font-mono ml-2">{pkg.taskId}</span> : null}
            <span className="ml-2">{pkg.title}</span>
          </div>
          <div className="text-xs tabular-nums text-text-secondary" data-testid="delivery-package-completeness">
            {t('dashboard.deliveryPackage.completeness', { ...pkg.completeness })}
          </div>
          <ul className="flex flex-col">
            {pkg.pieces.map((p) => (
              <PieceRow key={p.id} p={p} />
            ))}
          </ul>

          {pkg.falseGreens.length > 0 && (
            <div data-testid="delivery-package-false-greens">
              <span className="text-xs uppercase tracking-wide text-text-tertiary">{t('dashboard.deliveryPackage.falseGreens')}</span>
              <ul className="mt-1 flex flex-col gap-0.5">
                {pkg.falseGreens.map((g, i) => (
                  <li key={`${g.claim}-${i}`} className="text-[11px] text-error">
                    {g.claim} → <span className="text-warning">{g.rootCause}</span>
                    <span className="text-text-tertiary"> ({g.source})</span>
                  </li>
                ))}
              </ul>
              {pkg.falseGreensOmitted ? (
                <div className="text-[11px] text-text-tertiary">{t('dashboard.deliveryPackage.andMore', { count: pkg.falseGreensOmitted })}</div>
              ) : null}
            </div>
          )}

          <div>
            <span className="text-xs uppercase tracking-wide text-text-tertiary">{t('dashboard.deliveryPackage.receipts')}</span>
            {pkg.receipts.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-0.5">
                {pkg.receipts.map((r, i) => (
                  <li key={`${r}-${i}`} className="text-[11px] text-text-secondary">
                    {r}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[11px] text-warning" data-testid="delivery-package-no-receipts">
                {pkg.receiptsNote ?? t('dashboard.deliveryPackage.noReason')}
              </p>
            )}
          </div>

          {view.index.length > 1 && (
            <div>
              <span className="text-xs uppercase tracking-wide text-text-tertiary">{t('dashboard.deliveryPackage.others')}</span>
              <ul className="mt-1 flex flex-col gap-0.5">
                {view.index
                  .filter((row) => row.campaignId !== pkg.campaignId)
                  .slice(0, 5)
                  .map((row) => (
                    <li key={row.campaignId} className="text-[11px] text-text-secondary truncate">
                      <span className="font-mono text-text">{row.campaignId}</span> · {row.title} ·{' '}
                      {t('dashboard.deliveryPackage.completeness', { ...row.completeness })}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
