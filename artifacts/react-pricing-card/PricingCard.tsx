type PricingCardProps = {
  tier: string;
  price: string;
  period?: string;
  features: string[];
  featured?: boolean;
  ctaLabel?: string;
  onSelect?: () => void;
};

export function PricingCard({
  tier,
  price,
  period = "/mo",
  features,
  featured = false,
  ctaLabel = "Choose plan",
  onSelect,
}: PricingCardProps) {
  return (
    <div
      className={[
        "flex w-full max-w-sm flex-col rounded-2xl border p-6 shadow-sm",
        featured
          ? "border-indigo-500 ring-2 ring-indigo-500/30"
          : "border-slate-200",
      ].join(" ")}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-slate-900">{tier}</h3>
        {featured && (
          <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-medium text-indigo-700">
            Most popular
          </span>
        )}
      </div>

      <p className="mt-4 flex items-baseline gap-1">
        <span className="text-4xl font-bold tracking-tight text-slate-900">
          {price}
        </span>
        <span className="text-sm font-medium text-slate-500">{period}</span>
      </p>

      <ul className="mt-6 flex-1 space-y-3">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-slate-600">
            <svg
              className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.29 6.8-6.8a1 1 0 011.4 0z"
                clipRule="evenodd"
              />
            </svg>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onSelect}
        className={[
          "mt-8 rounded-xl px-4 py-2.5 text-sm font-semibold transition",
          featured
            ? "bg-indigo-600 text-white hover:bg-indigo-500"
            : "bg-slate-900 text-white hover:bg-slate-700",
        ].join(" ")}
      >
        {ctaLabel}
      </button>
    </div>
  );
}
