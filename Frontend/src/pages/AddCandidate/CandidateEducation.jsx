export const emptyEducation = { degree: "", fieldOfStudy: "", institution: "", startYear: "", endYear: "" };

export default function CandidateEducation({ data, setData }) {
  const setRow = (i, k, v) =>
    setData((d) => ({ ...d, education: d.education.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));
  const add = () => setData((d) => ({ ...d, education: [...d.education, { ...emptyEducation }] }));
  const remove = (i) => setData((d) => ({ ...d, education: d.education.filter((_, j) => j !== i) }));

  return (
    <>
      <div className="subhead">
        <h3>Education</h3>
        <button type="button" className="btn small" onClick={add}>+ Add education</button>
      </div>
      {data.education.length === 0 && <p className="muted">No education added (optional).</p>}
      {data.education.map((x, i) => (
        <div className="repeat" key={i}>
          <div className="grid2">
            <label className="full">Institution
              <input value={x.institution} onChange={(e) => setRow(i, "institution", e.target.value)} />
            </label>
            <label>Degree
              <input value={x.degree} onChange={(e) => setRow(i, "degree", e.target.value)} placeholder="B.Tech, MBA…" />
            </label>
            <label>Field of study
              <input value={x.fieldOfStudy} onChange={(e) => setRow(i, "fieldOfStudy", e.target.value)} />
            </label>
            <label>Start year
              <input type="number" value={x.startYear} onChange={(e) => setRow(i, "startYear", e.target.value)} />
            </label>
            <label>End year
              <input type="number" value={x.endYear} onChange={(e) => setRow(i, "endYear", e.target.value)} />
            </label>
          </div>
          <button type="button" className="btn small danger" onClick={() => remove(i)}>Remove</button>
        </div>
      ))}
    </>
  );
}
