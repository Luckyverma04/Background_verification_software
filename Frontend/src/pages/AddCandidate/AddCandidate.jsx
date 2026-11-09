
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createCandidate, errMsg, uploadCandidateImage } from "../../api/client";
import Icon from "../../components/Icon";
import { Notice, PageHeader } from "../../components/ui";

import CandidateBasicInfo from "./CandidateBasicInfo";
import CandidateProfessional from "./CandidateProfessional";
import CandidateEducation from "./CandidateEducation";
import CandidateSocialProfiles from "./CandidateSocialProfiles";

const STEPS = [
  "Basic info",
  "Professional",
  "Education",
  "Social profiles",
];

const initial = {
  fullName: "",
  email: "",
  phone: "",
  dateOfBirth: "",
  address: "",

  location: {
    city: "",
    state: "",
    country: "",
  },

  currentCompany: "",
  currentJobTitle: "",

  experience: [],
  education: [],

  linkedin: "",
  github: "",
  twitter: "",
  instagram: "",
  facebook: "",
  website: "",
};

function toPayload(f) {
  const clean = (o) =>
    Object.fromEntries(
      Object.entries(o).filter(
        ([, v]) => v !== "" && v != null
      )
    );

  const payload = clean({
    fullName: f.fullName.trim(),
    email: f.email,
    phone: f.phone,
    dateOfBirth: f.dateOfBirth,
    address: f.address,

    currentCompany: f.currentCompany,
    currentJobTitle: f.currentJobTitle,

    linkedin: f.linkedin,
    github: f.github,
    twitter: f.twitter,
    instagram: f.instagram,
    facebook: f.facebook,
    website: f.website,

    source: "MANUAL",
  });

  const loc = clean(f.location);

  if (Object.keys(loc).length) {
    payload.location = loc;
  }

  payload.experience = f.experience
    .map((x) => clean(x))
    .filter((x) => x.company || x.jobTitle);

  payload.education = f.education
    .map((x) => {
      const o = clean(x);

      if (o.startYear) {
        o.startYear = Number(o.startYear);
      }

      if (o.endYear) {
        o.endYear = Number(o.endYear);
      }

      return o;
    })
    .filter((x) => x.institution || x.degree);

  return payload;
}

export default function AddCandidate() {
  const nav = useNavigate();

  const [step, setStep] = useState(0);
  const [data, setData] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Photo: either a file from this computer or a public image URL
  const [imageFile, setImageFile] = useState(null);
  const [imageUrl, setImageUrl] = useState("");
  const [imagePreview, setImagePreview] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);

  const last = step === STEPS.length - 1;
  const canNext = step !== 0 || data.fullName.trim().length > 0;
  const props = { data, setData };

  const handleImageChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError("Please choose an image file (PNG or JPG).");
    if (file.size > 5 * 1024 * 1024) return setError("The image must be smaller than 5 MB.");
    setError("");
    setImageFile(file);
    setImageUrl("");
    setImagePreview(URL.createObjectURL(file));
  };

  const handleImageUrlChange = (event) => {
    const value = event.target.value;
    setImageUrl(value);
    setImageFile(null);
    setImagePreview(value.trim());
    setError("");
  };

  const clearImage = () => { setImageFile(null); setImageUrl(""); setImagePreview(""); };

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      const payload = toPayload(data);

      if (imageFile) {
        setUploadingImage(true);
        const uploaded = await uploadCandidateImage(imageFile);
        setUploadingImage(false);
        payload.source = "IMAGE";
        payload.sourceImageUrl = uploaded.url;
        payload.sourceImagePublicId = uploaded.publicId;
      } else if (imageUrl.trim()) {
        payload.sourceImageUrl = imageUrl.trim();
      }

      const candidate = await createCandidate(payload);
      nav(`/candidates/${candidate._id}`);
    } catch (e) {
      setUploadingImage(false);
      setError(errMsg(e) || "Could not create the candidate.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Add candidate" subtitle="Enter what you know. Only the full name is required; more details give better matches." />

      <div className="card">
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? "on" : i < step ? "done" : ""} onClick={() => (i <= step || canNext) && setStep(i)}>
              <b>{i < step ? <Icon name="check" size={15} strokeWidth={2.4} /> : i + 1}</b><span>{s}</span>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="photo-box">
            <div className={`photo-preview ${imagePreview ? "filled" : ""}`}>
              {imagePreview ? (
                <img src={imagePreview} alt="Candidate preview" referrerPolicy="no-referrer"
                  onError={() => { setError("Could not load this image."); setImagePreview(""); }} />
              ) : (
                <div className="stack" style={{ alignItems: "center" }}><Icon name="user" size={30} />Photo (optional)</div>
              )}
            </div>
            <div>
              <h3 style={{ marginBottom: 4 }}>Candidate photo</h3>
              <p className="muted" style={{ margin: "0 0 12px" }}>Upload from this computer or paste a public image link.</p>
              <label className="dropzone">
                <Icon name="upload" />
                <span className="grow">{imageFile ? imageFile.name : "Choose a PNG or JPG (max 5 MB)"}</span>
                <input type="file" accept="image/png,image/jpeg" onChange={handleImageChange} disabled={saving} />
              </label>
              <div className="or">OR</div>
              <div className="search" style={{ width: "100%" }}>
                <Icon name="link" size={16} />
                <input type="url" value={imageUrl} onChange={handleImageUrlChange} placeholder="https://example.com/photo.jpg" disabled={saving} aria-label="Image URL" />
              </div>
              {imagePreview && <button type="button" className="btn small ghost mt" onClick={clearImage}><Icon name="x" size={14} />Remove photo</button>}
            </div>
          </div>
        )}

        {step === 0 && <CandidateBasicInfo {...props} />}
        {step === 1 && <CandidateProfessional {...props} />}
        {step === 2 && <CandidateEducation {...props} />}
        {step === 3 && <CandidateSocialProfiles {...props} />}

        {error && <div className="mt"><Notice tone="error">{error}</Notice></div>}

        <div className="actions">
          <button className="btn" disabled={step === 0 || saving} onClick={() => setStep(step - 1)}>
            <Icon name="arrowLeft" size={15} />Back
          </button>
          {last ? (
            <button className="btn primary" disabled={saving || !data.fullName.trim()} onClick={submit}>
              <Icon name="check" size={16} />{uploadingImage ? "Uploading photo…" : saving ? "Saving…" : "Save candidate"}
            </button>
          ) : (
            <button className="btn primary" disabled={!canNext || saving} onClick={() => setStep(step + 1)}>
              Next<Icon name="arrowRight" size={15} />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
