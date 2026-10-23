const FIELDS = [
  ["linkedin", "LinkedIn", "https://linkedin.com/in/…"],
  ["github", "GitHub", "https://github.com/…"],
  ["twitter", "Twitter / X", "https://x.com/…"],
  ["instagram", "Instagram", "https://instagram.com/…"],
  ["facebook", "Facebook", "https://facebook.com/…"],
  ["website", "Personal website", "https://…"],
];

export default function CandidateSocialProfiles({ data, setData }) {
  return (
    <>
      <p className="muted">
        Add any profile links you already have. The search step uses these to find and cross-check the candidate online.
      </p>
      <div className="grid2">
        {FIELDS.map(([key, label, ph]) => (
          <label key={key}>{label}
            <input value={data[key]} placeholder={ph}
              onChange={(e) => setData((d) => ({ ...d, [key]: e.target.value }))} />
          </label>
        ))}
      </div>
    </>
  );
}
