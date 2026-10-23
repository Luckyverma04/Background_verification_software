export const emptyExperience = { company: "", jobTitle: "", startDate: "", endDate: "" };

export default function CandidateProfessional({ data, setData }) {
  const set = (k) => (e) => setData((d) => ({ ...d, [k]: e.target.value }));
  const setRow = (i, k, v) =>
    setData((d) => ({ ...d, experience: d.experience.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));
  const add = () => setData((d) => ({ ...d, experience: [...d.experience, { ...emptyExperience }] }));
  const remove = (i) => setData((d) => ({ ...d, experience: d.experience.filter((_, j) => j !== i) }));

  return (
    <>
      <div className="grid2">
        <label>Current company
          <input value={data.currentCompany} onChange={set("currentCompany")} />
        </label>
        <label>Current job title
          <input value={data.currentJobTitle} onChange={set("currentJobTitle")} />
        </label>
      </div>

      <div className="subhead">
        <h3>Work history</h3>
        <button type="button" className="btn small" onClick={add}>+ Add experience</button>
      </div>
      {data.experience.length === 0 && <p className="muted">No past experience added (optional).</p>}
      {data.experience.map((x, i) => (
        <div className="repeat" key={i}>
          <div className="grid2">
            <label>Company
              <input value={x.company} onChange={(e) => setRow(i, "company", e.target.value)} />
            </label>
            <label>Job title
              <input value={x.jobTitle} onChange={(e) => setRow(i, "jobTitle", e.target.value)} />
            </label>
            <label>Start date
              <input type="date" value={x.startDate} onChange={(e) => setRow(i, "startDate", e.target.value)} />
            </label>
            <label>End date
              <input type="date" value={x.endDate} onChange={(e) => setRow(i, "endDate", e.target.value)} />
            </label>
          </div>
          <button type="button" className="btn small danger" onClick={() => remove(i)}>Remove</button>
        </div>
      ))}
    </>
  );
}
