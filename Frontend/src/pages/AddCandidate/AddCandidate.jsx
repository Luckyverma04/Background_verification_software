
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createCandidate, errMsg } from "../../api/client";
import { PageHeader } from "../../components/ui";

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

  // Image upload state
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState("");

  // Image URL state
  const [imageUrl, setImageUrl] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);

  const last = step === STEPS.length - 1;

  const canNext =
    step !== 0 || data.fullName.trim().length > 0;

  const props = {
    data,
    setData,
  };

  // Upload image from PC
  const handleImageChange = (event) => {
    const file = event.target.files?.[0];

    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setError("Please select a valid image.");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setError("Image size must be less than 5MB.");
      return;
    }

    setError("");
    setImageFile(file);
    setImageUrl("");

    const previewUrl = URL.createObjectURL(file);
    setImagePreview(previewUrl);
  };

  // Image URL change
  const handleImageUrlChange = (event) => {
    const value = event.target.value;

    setImageUrl(value);

    if (value.trim()) {
      setImageFile(null);
      setImagePreview(value.trim());
    } else {
      setImagePreview("");
    }

    setError("");
  };

  // Upload PC image
  const uploadImageFile = async () => {
    if (!imageFile) return null;

    const formData = new FormData();
    formData.append("image", imageFile);

    const API_URL =
      import.meta.env.VITE_API_URL ||
      "http://localhost:5000/api";

    const response = await fetch(
      `${API_URL}/uploads/candidate-image`,
      {
        method: "POST",
        body: formData,
      }
    );

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(
        result.message || "Image upload failed."
      );
    }

    return result.data;
  };

  // Upload image from URL
  const uploadImageFromUrl = async () => {
    if (!imageUrl.trim()) return null;

    const API_URL =
      import.meta.env.VITE_API_URL ||
      "http://localhost:5000/api";

    const response = await fetch(
      `${API_URL}/uploads/candidate-image-url`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          imageUrl: imageUrl.trim(),
        }),
      }
    );

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(
        result.message || "Image URL upload failed."
      );
    }

    return result.data;
  };

  // Submit candidate
  const submit = async () => {
    setSaving(true);
    setError("");

    try {
      let imageData = null;

      if (imageFile) {
        setUploadingImage(true);
        imageData = await uploadImageFile();
      } else if (imageUrl.trim()) {
        setUploadingImage(true);
        imageData = await uploadImageFromUrl();
      }

      setUploadingImage(false);

      const payload = toPayload(data);

      if (imageData) {
        payload.source = "IMAGE";
        payload.sourceImageUrl = imageData.url;
        payload.sourceImagePublicId = imageData.publicId;
      }

      const candidate = await createCandidate(payload);

      nav(`/candidates/${candidate._id}`);
    } catch (e) {
      console.error("Create candidate error:", e);

      setUploadingImage(false);

      setError(
        errMsg(e) ||
          e.message ||
          "Could not create candidate."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Add candidate"
        subtitle="Enter the details to be verified."
      />

      <div className="card">
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={
                i === step
                  ? "on"
                  : i < step
                  ? "done"
                  : ""
              }
              onClick={() =>
                (i <= step || canNext) && setStep(i)
              }
            >
              <b>{i < step ? "✓" : i + 1}</b> {s}
            </li>
          ))}
        </ol>

        {/* Candidate image section */}
        <div
          style={{
            marginBottom: "28px",
            padding: "22px",
            borderRadius: "16px",
            border: "1px solid #dbe4ff",
            background:
              "linear-gradient(135deg, #f5f7ff 0%, #eef2ff 100%)",
          }}
        >
          <div style={{ marginBottom: "16px" }}>
            <h3
              style={{
                margin: 0,
                fontSize: "18px",
                fontWeight: 700,
                color: "#1e2a5a",
              }}
            >
              Candidate Image
            </h3>

            <p
              style={{
                margin: "5px 0 0",
                color: "#667085",
                fontSize: "14px",
              }}
            >
              Upload from your computer or provide an image URL.
            </p>
          </div>

          <div
            style={{
              padding: "16px",
              background: "#ffffff",
              borderRadius: "12px",
              border: "1px solid #e0e7ff",
              marginBottom: "14px",
            }}
          >
            <label
              style={{
                display: "block",
                fontWeight: 600,
                color: "#344054",
                marginBottom: "8px",
              }}
            >
              📁 Upload from PC
            </label>

            <input
              type="file"
              accept="image/png,image/jpeg,image/jpg"
              onChange={handleImageChange}
              disabled={saving || uploadingImage}
            />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              margin: "12px 0",
              color: "#98a2b3",
              fontSize: "13px",
            }}
          >
            <div
              style={{
                flex: 1,
                height: "1px",
                background: "#d0d5dd",
              }}
            />
            OR
            <div
              style={{
                flex: 1,
                height: "1px",
                background: "#d0d5dd",
              }}
            />
          </div>

          <div
            style={{
              padding: "16px",
              background: "#ffffff",
              borderRadius: "12px",
              border: "1px solid #e0e7ff",
            }}
          >
            <label
              style={{
                display: "block",
                fontWeight: 600,
                color: "#344054",
                marginBottom: "8px",
              }}
            >
              🔗 Image URL
            </label>

            <input
              type="url"
              value={imageUrl}
              onChange={handleImageUrlChange}
              placeholder="https://example.com/image.jpg"
              disabled={saving || uploadingImage}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "11px 13px",
                border: "1px solid #c7d2fe",
                borderRadius: "8px",
                outline: "none",
                fontSize: "14px",
              }}
            />
          </div>

          {imagePreview && (
            <div
              style={{
                marginTop: "18px",
                padding: "14px",
                background: "#ffffff",
                borderRadius: "12px",
                border: "1px solid #dbe4ff",
              }}
            >
              <p
                style={{
                  margin: "0 0 10px",
                  fontWeight: 600,
                  color: "#344054",
                }}
              >
                Preview
              </p>

              <img
                src={imagePreview}
                alt="Candidate preview"
                style={{
                  width: "150px",
                  height: "150px",
                  objectFit: "cover",
                  borderRadius: "12px",
                  border: "2px solid #6366f1",
                  display: "block",
                }}
                onError={() => {
                  setError("Could not load this image URL.");
                  setImagePreview("");
                }}
              />

              {imageFile && (
                <p
                  style={{
                    margin: "8px 0 0",
                    fontSize: "13px",
                    color: "#667085",
                  }}
                >
                  {imageFile.name}
                </p>
              )}
            </div>
          )}

          {uploadingImage && (
            <div
              style={{
                marginTop: "14px",
                padding: "10px 12px",
                borderRadius: "8px",
                background: "#eef2ff",
                color: "#4338ca",
                fontSize: "14px",
                fontWeight: 600,
              }}
            >
              ⏳ Uploading image to Cloudinary...
            </div>
          )}
        </div>

        {/* Form steps */}
        {step === 0 && <CandidateBasicInfo {...props} />}
        {step === 1 && <CandidateProfessional {...props} />}
        {step === 2 && <CandidateEducation {...props} />}
        {step === 3 && <CandidateSocialProfiles {...props} />}

        {error && <div className="state error">{error}</div>}

        <div className="actions">
          <button
            className="btn"
            disabled={step === 0 || saving}
            onClick={() => setStep(step - 1)}
          >
            Back
          </button>

          {last ? (
            <button
              className="btn primary"
              disabled={saving || !data.fullName.trim()}
              onClick={submit}
            >
              {uploadingImage
                ? "Uploading image..."
                : saving
                ? "Saving..."
                : "Save candidate"}
            </button>
          ) : (
            <button
              className="btn primary"
              disabled={!canNext || saving}
              onClick={() => setStep(step + 1)}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </>
  );
}
