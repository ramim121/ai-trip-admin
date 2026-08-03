import { CouponType } from '@/generated/prisma/enums'

/**
 * The promo code form, shared by create and edit.
 *
 * ONE COMPONENT FOR BOTH, because the fields are identical and the two screens
 * differ only in which action they post to and whether an id rides along. Two
 * copies would drift the first time a column is added, and the copy nobody
 * remembers is the one that quietly stops writing the new field.
 *
 * No client JavaScript, like every other console screen. So the
 * percent-versus-taka distinction cannot be enforced by hiding a field as
 * somebody types: both are always shown, each labelled with when it applies, and
 * the action refuses the impossible combinations with a sentence. The CHECK
 * constraints refuse them again underneath.
 */

interface CouponFormFieldsProps {
  /** Null when creating. */
  coupon: {
    id: string
    code: string
    label: string
    description: string | null
    type: CouponType
    value: number
    maxDiscountBdt: number | null
    minSpendBdt: number | null
    startsAt: Date | null
    endsAt: Date | null
    maxRedemptions: number | null
    maxPerUser: number
    isActive: boolean
  } | null
}

const FIELD =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950'
const LABEL = 'block text-sm font-medium'
const HINT = 'mt-1 text-xs text-zinc-500 dark:text-zinc-400'

/**
 * A moment as `<input type="datetime-local">` wants it: `YYYY-MM-DDTHH:mm`.
 *
 * Rendered in Dhaka so it round-trips with how the action parses it back.
 * `sv-SE` is used because it natively formats to ISO order — one `replace` from
 * what the input needs — whereas building the string from `getFullYear()` and
 * friends would silently use the server's zone instead.
 */
function toLocalInput(value: Date | null): string {
  if (value === null) return ''

  const formatted = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value)

  return formatted.replace(' ', 'T')
}

export function CouponFormFields({ coupon }: CouponFormFieldsProps) {
  return (
    <div className="space-y-5">
      {coupon !== null && <input type="hidden" name="id" value={coupon.id} />}

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="code">
            Code
          </label>
          <input
            id="code"
            name="code"
            defaultValue={coupon?.code ?? ''}
            required
            minLength={3}
            maxLength={32}
            placeholder="EARLYBIRD"
            className={`${FIELD} font-mono uppercase`}
          />
          <p className={HINT}>
            Uppercased on save. Letters, numbers and hyphens.
            {coupon !== null && ' Renaming a code that has been handed out stops it working.'}
          </p>
        </div>

        <div>
          <label className={LABEL} htmlFor="label">
            What the traveller sees
          </label>
          <input
            id="label"
            name="label"
            defaultValue={coupon?.label ?? ''}
            required
            maxLength={160}
            placeholder="Early bird — 15% off"
            className={FIELD}
          />
          <p className={HINT}>Shown beside the discount at checkout.</p>
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="description">
          Internal note
        </label>
        <textarea
          id="description"
          name="description"
          defaultValue={coupon?.description ?? ''}
          maxLength={2000}
          rows={2}
          className={FIELD}
        />
        <p className={HINT}>For staff. Never shown to anybody buying.</p>
      </div>

      <fieldset className="grid gap-5 sm:grid-cols-3">
        <legend className="text-sm font-medium">The discount</legend>

        <div>
          <label className={LABEL} htmlFor="type">
            Type
          </label>
          <select
            id="type"
            name="type"
            defaultValue={coupon?.type ?? CouponType.PERCENT}
            className={FIELD}
          >
            <option value={CouponType.PERCENT}>Percentage off</option>
            <option value={CouponType.FIXED}>Taka off</option>
          </select>
        </div>

        <div>
          <label className={LABEL} htmlFor="value">
            Amount
          </label>
          <input
            id="value"
            name="value"
            type="number"
            min={1}
            step={1}
            defaultValue={coupon?.value ?? 10}
            required
            className={FIELD}
          />
          <p className={HINT}>1–100 for a percentage, whole taka for a fixed amount.</p>
        </div>

        <div>
          <label className={LABEL} htmlFor="maxDiscountBdt">
            Cap (BDT)
          </label>
          <input
            id="maxDiscountBdt"
            name="maxDiscountBdt"
            type="number"
            min={1}
            step={1}
            defaultValue={coupon?.maxDiscountBdt ?? ''}
            className={FIELD}
          />
          {/* The schema's own warning, repeated where the decision gets made:
              20% of a ৳112,000 trip is ৳22,400. */}
          <p className={HINT}>
            Percentage codes only. Blank means uncapped — worth a moment&rsquo;s thought, since a
            fifth of a large trip is a large number.
          </p>
        </div>
      </fieldset>

      <fieldset className="grid gap-5 sm:grid-cols-3">
        <legend className="text-sm font-medium">Limits</legend>

        <div>
          <label className={LABEL} htmlFor="minSpendBdt">
            Minimum spend (BDT)
          </label>
          <input
            id="minSpendBdt"
            name="minSpendBdt"
            type="number"
            min={0}
            step={1}
            defaultValue={coupon?.minSpendBdt ?? ''}
            className={FIELD}
          />
          <p className={HINT}>Blank = any amount</p>
        </div>

        <div>
          <label className={LABEL} htmlFor="maxRedemptions">
            Total uses
          </label>
          <input
            id="maxRedemptions"
            name="maxRedemptions"
            type="number"
            min={1}
            step={1}
            defaultValue={coupon?.maxRedemptions ?? ''}
            className={FIELD}
          />
          <p className={HINT}>Blank = unlimited</p>
        </div>

        <div>
          <label className={LABEL} htmlFor="maxPerUser">
            Uses per account
          </label>
          <input
            id="maxPerUser"
            name="maxPerUser"
            type="number"
            min={1}
            step={1}
            defaultValue={coupon?.maxPerUser ?? 1}
            required
            className={FIELD}
          />
          <p className={HINT}>One is what a promo code usually means.</p>
        </div>
      </fieldset>

      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="text-sm font-medium">When it runs</legend>

        <div>
          <label className={LABEL} htmlFor="startsAt">
            Starts
          </label>
          <input
            id="startsAt"
            name="startsAt"
            type="datetime-local"
            defaultValue={toLocalInput(coupon?.startsAt ?? null)}
            className={FIELD}
          />
          <p className={HINT}>Dhaka time. Blank = live as soon as it is switched on.</p>
        </div>

        <div>
          <label className={LABEL} htmlFor="endsAt">
            Ends
          </label>
          <input
            id="endsAt"
            name="endsAt"
            type="datetime-local"
            defaultValue={toLocalInput(coupon?.endsAt ?? null)}
            className={FIELD}
          />
          <p className={HINT}>Dhaka time. Blank = runs until switched off.</p>
        </div>
      </fieldset>

      <div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="isActive"
            defaultChecked={coupon?.isActive ?? true}
            className="size-4"
          />
          Active
        </label>
        <p className={HINT}>
          The first thing the booking engine checks. Switching it off stops the code immediately,
          and keeps every redemption already made against it.
        </p>
      </div>
    </div>
  )
}
