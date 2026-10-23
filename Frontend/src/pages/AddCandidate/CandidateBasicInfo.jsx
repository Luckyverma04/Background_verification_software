
export default function CandidateBasicInfo({ data, setData }) {
  const set = (key) => (event) =>
    setData((previous) => ({
      ...previous,
      [key]: event.target.value,
    }));

  const setLoc = (key) => (event) =>
    setData((previous) => ({
      ...previous,
      location: {
        ...previous.location,
        [key]: event.target.value,
      },
    }));

  return (
    <div className="grid2">
      <label className="full">
        Full name *
        <input
          value={data.fullName}
          onChange={set("fullName")}
          placeholder="e.g. Rahul Sharma"
          autoFocus
        />
      </label>

      <label>
        Email
        <input
          type="email"
          value={data.email}
          onChange={set("email")}
          placeholder="name@example.com"
        />
      </label>

      <label>
        Phone
        <input
          type="tel"
          value={data.phone}
          onChange={set("phone")}
          placeholder="+91 98765 43210"
        />
      </label>

      <label>
        Date of Birth
        <input
          type="date"
          value={data.dateOfBirth}
          onChange={set("dateOfBirth")}
        />
      </label>

      <label className="full">
        Full Address
        <textarea
          value={data.address}
          onChange={set("address")}
          placeholder="House/Street, Area, City, State, PIN code"
          rows={3}
        />
      </label>

      <label>
        City
        <input
          value={data.location.city}
          onChange={setLoc("city")}
          placeholder="e.g. Indore"
        />
      </label>

      <label>
        State
        <input
          value={data.location.state}
          onChange={setLoc("state")}
          placeholder="e.g. Madhya Pradesh"
        />
      </label>

      <label>
        Country
        <input
          value={data.location.country}
          onChange={setLoc("country")}
          placeholder="e.g. India"
        />
      </label>
    </div>
  );
}
