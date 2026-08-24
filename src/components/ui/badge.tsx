import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * The status chip the admin UI was already drawing by hand.
 *
 * Every page had its own copy of `rounded-full px-2 py-0.5 text-[10px]
 * font-medium bg-{tone}-500/15 text-{tone}-400`, and they had drifted: SeriesList
 * and Activity use the `-400` foreground scale, SeriesDetail used `-500`, and
 * errors were `text-red-400` in two files and `text-destructive` in four. The
 * variants below settle that — `-400` and `text-destructive`.
 *
 * Tones carry meaning, so pick by what the thing *is*, not by colour:
 *   done    something finished and is good          (emerald)
 *   active  in flight right now                     (sky)
 *   accent  running / admin-only / notable          (violet)
 *   warn    degraded, stalled, needs a human         (amber)
 *   error   broken                                  (destructive)
 *   muted   idle, pending, not applicable           (neutral)
 *
 * Deliberately dependency-free — `class-variance-authority` is already used by
 * button.tsx. Radix primitives (Tooltip/Collapsible/Tabs) would each add an npm
 * dependency for interactions the hand-rolled patterns already cover.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap',
  {
    variants: {
      tone: {
        done: 'bg-emerald-500/15 text-emerald-400',
        active: 'bg-sky-500/15 text-sky-400',
        accent: 'bg-violet-500/15 text-violet-300',
        warn: 'bg-amber-500/15 text-amber-400',
        error: 'bg-destructive/15 text-destructive',
        muted: 'bg-muted text-muted-foreground',
      },
      /** Square corners for inline tags on text ("Filler", "Recap", audio pills). */
      shape: {
        pill: 'rounded-full',
        tag: 'rounded px-1.5 uppercase tracking-wide',
      },
    },
    defaultVariants: { tone: 'muted', shape: 'pill' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, shape, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, shape }), className)} {...props} />
}

export { badgeVariants }
