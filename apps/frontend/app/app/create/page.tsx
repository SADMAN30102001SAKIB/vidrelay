"use client";

import { createPostSchema, platformLabels, platforms } from "@vidrelay/shared";
import { ChevronDown, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type {
  Capability,
  Connection,
  Platform,
  Post,
  PostDestinationInput,
  Upload
} from "@vidrelay/shared";
import type { FormEvent } from "react";

import { VideoUploader } from "@/components/VideoUploader";
import {
  Button,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  PlatformMark,
  StatusBadge
} from "@/components/ui";
import { apiRequest, errorMessage } from "@/lib/api";
import {
  cannotPublish,
  privateTikTokAccountEligible,
  resolveTikTokPrivacy
} from "@/lib/publishing";
import type { TikTokPrivacy, TikTokPrivacyOption } from "@/lib/publishing";
import { capabilityStatusView } from "@/lib/status";
import { useSession } from "@/providers/SessionProvider";

type ConnectionSelection = Partial<Record<Platform, string>>;

interface TikTokCreatorInfo {
  comment_disabled: boolean;
  creator_avatar_url?: string;
  creator_nickname: string;
  duet_disabled: boolean;
  max_video_post_duration_sec: number;
  privacy_level_options: TikTokPrivacyOption[];
  stitch_disabled: boolean;
}

export default function CreatePostPage() {
  const { config } = useSession();
  const router = useRouter();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selected, setSelected] = useState<ConnectionSelection>({});
  const [upload, setUpload] = useState<Upload | null>(null);
  const [sharedCaption, setSharedCaption] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [facebookTitle, setFacebookTitle] = useState("");
  const [facebookDescription, setFacebookDescription] = useState("");
  const [instagramCaption, setInstagramCaption] = useState("");
  const [instagramShareToFeed, setInstagramShareToFeed] = useState(true);
  const [youtubeTitle, setYoutubeTitle] = useState("");
  const [youtubeDescription, setYoutubeDescription] = useState("");
  const [youtubeCategory, setYoutubeCategory] = useState("22");
  const [youtubeAudience, setYoutubeAudience] = useState<
    "" | "not_for_kids" | "for_kids"
  >("");
  const [youtubePrivacy, setYoutubePrivacy] = useState<
    "private" | "public" | "unlisted"
  >("private");
  const [youtubeSynthetic, setYoutubeSynthetic] = useState(false);
  const [tiktokTitle, setTiktokTitle] = useState("");
  const [tiktokPrivacy, setTiktokPrivacy] = useState<TikTokPrivacy>("");
  const [tiktokComments, setTiktokComments] = useState(false);
  const [tiktokDuet, setTiktokDuet] = useState(false);
  const [tiktokStitch, setTiktokStitch] = useState(false);
  const [tiktokAi, setTiktokAi] = useState(false);
  const [tiktokCommercialContent, setTiktokCommercialContent] = useState(false);
  const [tiktokOwnBrand, setTiktokOwnBrand] = useState(false);
  const [tiktokBranded, setTiktokBranded] = useState(false);
  const [tiktokConsent, setTiktokConsent] = useState(false);
  const [creatorInfo, setCreatorInfo] = useState<TikTokCreatorInfo | null>(
    null
  );
  const [creatorLoading, setCreatorLoading] = useState(false);
  const [creatorError, setCreatorError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    const load = async () => {
      try {
        const body = await apiRequest<{ connections: Connection[] }>(
          "/api/connections"
        );
        setConnections(body.connections);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    const connectionId = selected.tiktok;
    setCreatorInfo(null);
    setCreatorError(null);
    setTiktokPrivacy("");
    setTiktokComments(false);
    setTiktokDuet(false);
    setTiktokStitch(false);
    setTiktokCommercialContent(false);
    setTiktokOwnBrand(false);
    setTiktokBranded(false);
    setTiktokConsent(false);
    if (connectionId === undefined) {
      setCreatorLoading(false);
      return;
    }
    setCreatorLoading(true);
    let cancelled = false;
    void apiRequest<{ creatorInfo: TikTokCreatorInfo }>(
      `/api/connections/${connectionId}/tiktok/creator-info`,
      { method: "POST" }
    )
      .then(body => {
        if (cancelled) {
          return;
        }
        setCreatorError(null);
        setCreatorInfo(body.creatorInfo);
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        setCreatorInfo(null);
        setCreatorError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) {
          setCreatorLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected.tiktok]);

  const connectedByPlatform = useMemo(
    () =>
      Object.fromEntries(
        platforms.map(platform => [
          platform,
          connections.filter(
            connection =>
              connection.platform === platform &&
              connection.status === "connected"
          )
        ])
      ) as Record<Platform, Connection[]>,
    [connections]
  );

  const capabilityFor = (platform: Platform): Capability | undefined =>
    config?.capabilities.find(capability => capability.platform === platform);

  const togglePlatform = (platform: Platform) => {
    const current = selected[platform];
    if (current !== undefined) {
      setSelected(value => {
        const next = { ...value };
        delete next[platform];
        return next;
      });
      return;
    }
    const first = connectedByPlatform[platform][0];
    if (first !== undefined) {
      setSelected(value => ({ ...value, [platform]: first.id }));
    }
  };

  const selectConnection = (platform: Platform, id: string) => {
    setSelected(current => ({ ...current, [platform]: id }));
  };

  const effectiveTikTokPrivacy = resolveTikTokPrivacy(
    capabilityFor("tiktok")?.mode,
    creatorInfo,
    tiktokPrivacy
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (upload === null) {
      setError("Upload and verify a video before publishing.");
      return;
    }

    const destinations: PostDestinationInput[] = [];
    if (selected.facebook !== undefined) {
      destinations.push({
        connectionId: selected.facebook,
        platform: "facebook",
        settings: {
          description: facebookDescription || sharedCaption,
          ...(facebookTitle.trim() === "" ? {} : { title: facebookTitle })
        }
      });
    }
    if (selected.instagram !== undefined) {
      destinations.push({
        connectionId: selected.instagram,
        platform: "instagram",
        settings: {
          caption: instagramCaption || sharedCaption,
          shareToFeed: instagramShareToFeed
        }
      });
    }
    if (selected.youtube !== undefined) {
      destinations.push({
        connectionId: selected.youtube,
        platform: "youtube",
        settings: {
          categoryId: youtubeCategory,
          containsSyntheticMedia: youtubeSynthetic,
          description: youtubeDescription || sharedCaption,
          madeForKids: youtubeAudience === "for_kids",
          privacyStatus:
            capabilityFor("youtube")?.mode === "private_only"
              ? "private"
              : youtubePrivacy,
          title: youtubeTitle
        }
      });
    }
    if (selected.tiktok !== undefined && effectiveTikTokPrivacy !== null) {
      destinations.push({
        connectionId: selected.tiktok,
        platform: "tiktok",
        settings: {
          brandedContent: tiktokBranded,
          consentConfirmed: true,
          disableComment: !tiktokComments,
          disableDuet: !tiktokDuet,
          disableStitch: !tiktokStitch,
          isAiGenerated: tiktokAi,
          ownBrand: tiktokOwnBrand,
          privacyLevel: effectiveTikTokPrivacy,
          title: tiktokTitle || sharedCaption
        }
      });
    }

    if (selected.youtube !== undefined && youtubeAudience === "") {
      setError("Choose the YouTube audience setting before publishing.");
      return;
    }
    if (
      selected.instagram !== undefined &&
      instagramCaption.trim() === "" &&
      sharedCaption.length > 2200
    ) {
      setError(
        "Instagram captions can contain at most 2,200 characters. Add a shorter Instagram override."
      );
      return;
    }
    if (
      selected.tiktok !== undefined &&
      tiktokTitle.trim() === "" &&
      sharedCaption.length > 2200
    ) {
      setError(
        "TikTok captions can contain at most 2,200 characters. Add a shorter TikTok override."
      );
      return;
    }
    if (
      selected.tiktok !== undefined &&
      effectiveTikTokPrivacy === "SELF_ONLY" &&
      tiktokBranded
    ) {
      setError("TikTok branded content cannot use Only me visibility.");
      return;
    }
    if (
      selected.tiktok !== undefined &&
      capabilityFor("tiktok")?.mode === "private_only" &&
      !privateTikTokAccountEligible(creatorInfo)
    ) {
      setError(
        "This TikTok connection is not an eligible private creator account for unaudited Direct Post."
      );
      return;
    }
    if (selected.tiktok !== undefined && effectiveTikTokPrivacy === null) {
      setError(
        "Choose a TikTok privacy option that is currently available for this account."
      );
      return;
    }
    if (
      selected.tiktok !== undefined &&
      creatorInfo !== null &&
      upload.durationMs !== null &&
      upload.durationMs / 1000 > creatorInfo.max_video_post_duration_sec
    ) {
      setError(
        `This TikTok account allows videos up to ${creatorInfo.max_video_post_duration_sec} seconds.`
      );
      return;
    }
    if (selected.tiktok !== undefined && !tiktokConsent) {
      setError(
        "Choose TikTok privacy and confirm TikTok’s publishing consent."
      );
      return;
    }
    if (
      selected.tiktok !== undefined &&
      tiktokCommercialContent &&
      !tiktokOwnBrand &&
      !tiktokBranded
    ) {
      setError(
        "Choose Your brand, Branded content, or both for TikTok commercial content."
      );
      return;
    }

    const parsed = createPostSchema.safeParse({
      destinations,
      idempotencyKey,
      rightsConfirmed,
      sharedCaption,
      uploadId: upload.id
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Review the destination settings."
      );
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const body = await apiRequest<{ idempotentReplay: boolean; post: Post }>(
        "/api/posts",
        {
          body: JSON.stringify(parsed.data),
          method: "POST"
        }
      );
      router.push(`/app/posts/detail?id=${encodeURIComponent(body.post.id)}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <LoadingState label="Preparing the publishing form…" />;
  }
  if (error !== null && connections.length === 0) {
    return (
      <ErrorState
        action={
          <Button onClick={() => window.location.reload()}>Try again</Button>
        }
        description={error}
      />
    );
  }

  const selectedPlatforms = platforms.filter(
    platform => selected[platform] !== undefined
  );
  return (
    <form className="stack" onSubmit={event => void submit(event)}>
      <PageHeader
        description="The post is submitted immediately after validation; v1 does not schedule or transcode media."
        eyebrow="New publishing job"
        title="Create post"
      />
      {error === null ? null : <Notice tone="danger">{error}</Notice>}

      <div className="compose-layout">
        <div className="compose-main stack">
          <section className="panel stack" aria-labelledby="media-heading">
            <div className="panel-header">
              <div>
                <h2 id="media-heading">1. Upload media</h2>
                <p>
                  Browser checks run first; the backend is authoritative for
                  codecs and integrity.
                </p>
              </div>
            </div>
            <VideoUploader
              config={config}
              onUploadChange={value => {
                setUpload(value);
                setTiktokConsent(false);
              }}
            />
          </section>

          <section className="panel stack" aria-labelledby="caption-heading">
            <div>
              <h2 id="caption-heading">2. Write the shared caption</h2>
              <p>Each destination editor can override this text.</p>
            </div>
            <div className="field">
              <label htmlFor="shared-caption">Shared caption</label>
              <textarea
                className="textarea"
                id="shared-caption"
                maxLength={5000}
                onChange={event => {
                  setSharedCaption(event.target.value);
                  if (tiktokTitle.trim() === "") {
                    setTiktokConsent(false);
                  }
                }}
                rows={5}
                value={sharedCaption}
              />
              <span className="character-count">
                {sharedCaption.length}/5000
              </span>
            </div>
          </section>

          <section
            className="panel stack"
            aria-labelledby="destinations-heading">
            <div>
              <h2 id="destinations-heading">3. Choose destinations</h2>
              <p>
                Only connected accounts in a publishable service mode can be
                selected.
              </p>
            </div>
            <div className="platform-selector">
              {platforms.map(platform => {
                const capability = capabilityFor(platform);
                const noConnection = connectedByPlatform[platform].length === 0;
                const disabled =
                  noConnection ||
                  cannotPublish(capability, config?.environment);
                const checked = selected[platform] !== undefined;
                return (
                  <label
                    className={`platform-choice${checked ? " platform-choice-selected" : ""}${disabled ? " platform-choice-disabled" : ""}`}
                    key={platform}>
                    <input
                      checked={checked}
                      disabled={disabled}
                      onChange={() => togglePlatform(platform)}
                      type="checkbox"
                    />
                    <PlatformMark platform={platform} />
                    <span>
                      <strong>{platformLabels[platform]}</strong>
                      <small>
                        {noConnection
                          ? "No connected account"
                          : (capability?.message ?? "Capability unavailable")}
                      </small>
                    </span>
                    {capability === undefined ? null : (
                      <StatusBadge {...capabilityStatusView(capability.mode)} />
                    )}
                  </label>
                );
              })}
            </div>
          </section>

          {selectedPlatforms.map(platform => {
            const accounts = connectedByPlatform[platform];
            return (
              <details className="destination-editor" key={platform} open>
                <summary>
                  <span className="cluster">
                    <PlatformMark platform={platform} />
                    <strong>{platformLabels[platform]} settings</strong>
                  </span>
                  <ChevronDown aria-hidden="true" size={18} />
                </summary>
                <div className="destination-fields">
                  <div className="field">
                    <label htmlFor={`${platform}-connection`}>
                      Publishing account
                    </label>
                    <select
                      className="select"
                      id={`${platform}-connection`}
                      onChange={event =>
                        selectConnection(platform, event.target.value)
                      }
                      value={selected[platform]}>
                      {accounts.map(connection => (
                        <option key={connection.id} value={connection.id}>
                          {connection.displayName}
                        </option>
                      ))}
                    </select>
                  </div>

                  {platform === "facebook" ? (
                    <>
                      <div className="field">
                        <label htmlFor="facebook-title">
                          Video title (optional)
                        </label>
                        <input
                          className="input"
                          id="facebook-title"
                          maxLength={255}
                          onChange={event =>
                            setFacebookTitle(event.target.value)
                          }
                          value={facebookTitle}
                        />
                        <span className="character-count">
                          {facebookTitle.length}/255
                        </span>
                      </div>
                      <div className="field">
                        <label htmlFor="facebook-description">
                          Description override
                        </label>
                        <textarea
                          className="textarea"
                          id="facebook-description"
                          maxLength={5000}
                          onChange={event =>
                            setFacebookDescription(event.target.value)
                          }
                          placeholder="Leave empty to use the shared caption"
                          rows={4}
                          value={facebookDescription}
                        />
                      </div>
                    </>
                  ) : null}

                  {platform === "instagram" ? (
                    <>
                      <div className="field">
                        <label htmlFor="instagram-caption">
                          Caption override
                        </label>
                        <textarea
                          className="textarea"
                          id="instagram-caption"
                          maxLength={2200}
                          onChange={event =>
                            setInstagramCaption(event.target.value)
                          }
                          placeholder="Leave empty to use the shared caption"
                          rows={4}
                          value={instagramCaption}
                        />
                        <span className="character-count">
                          {instagramCaption.length}/2200
                        </span>
                      </div>
                      <label className="check-row">
                        <input
                          checked={instagramShareToFeed}
                          onChange={event =>
                            setInstagramShareToFeed(event.target.checked)
                          }
                          type="checkbox"
                        />
                        Also share the reel to the connected account’s feed
                      </label>
                    </>
                  ) : null}

                  {platform === "youtube" ? (
                    <>
                      {capabilityFor("youtube")?.mode === "private_only" ? (
                        <Notice tone="info">
                          This service is limited to private YouTube uploads.
                        </Notice>
                      ) : null}
                      <div className="field">
                        <label htmlFor="youtube-title">Title</label>
                        <input
                          className="input"
                          id="youtube-title"
                          maxLength={100}
                          onChange={event =>
                            setYoutubeTitle(event.target.value)
                          }
                          required
                          value={youtubeTitle}
                        />
                        <span className="character-count">
                          {youtubeTitle.length}/100
                        </span>
                      </div>
                      <div className="field">
                        <label htmlFor="youtube-description">
                          Description override
                        </label>
                        <textarea
                          className="textarea"
                          id="youtube-description"
                          maxLength={5000}
                          onChange={event =>
                            setYoutubeDescription(event.target.value)
                          }
                          placeholder="Leave empty to use the shared caption"
                          rows={4}
                          value={youtubeDescription}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="youtube-category">Category ID</label>
                        <input
                          className="input"
                          id="youtube-category"
                          inputMode="numeric"
                          onChange={event =>
                            setYoutubeCategory(event.target.value)
                          }
                          pattern="[0-9]+"
                          required
                          value={youtubeCategory}
                        />
                        <span className="field-help">
                          22 is YouTube’s People & Blogs category.
                        </span>
                      </div>
                      <div className="field">
                        <label htmlFor="youtube-privacy">Visibility</label>
                        <select
                          className="select"
                          disabled={
                            capabilityFor("youtube")?.mode === "private_only"
                          }
                          id="youtube-privacy"
                          onChange={event =>
                            setYoutubePrivacy(
                              event.target.value as typeof youtubePrivacy
                            )
                          }
                          value={
                            capabilityFor("youtube")?.mode === "private_only"
                              ? "private"
                              : youtubePrivacy
                          }>
                          <option value="private">Private</option>
                          <option value="unlisted">Unlisted</option>
                          <option value="public">Public</option>
                        </select>
                      </div>
                      <fieldset className="fieldset">
                        <legend>Audience</legend>
                        <label className="radio-row">
                          <input
                            checked={youtubeAudience === "for_kids"}
                            name="youtube-audience"
                            onChange={() => setYoutubeAudience("for_kids")}
                            type="radio"
                          />{" "}
                          Yes, it’s made for kids
                        </label>
                        <label className="radio-row">
                          <input
                            checked={youtubeAudience === "not_for_kids"}
                            name="youtube-audience"
                            onChange={() => setYoutubeAudience("not_for_kids")}
                            type="radio"
                          />{" "}
                          No, it’s not made for kids
                        </label>
                      </fieldset>
                      <label className="check-row">
                        <input
                          checked={youtubeSynthetic}
                          onChange={event =>
                            setYoutubeSynthetic(event.target.checked)
                          }
                          type="checkbox"
                        />{" "}
                        Contains realistic altered or synthetic media
                      </label>
                    </>
                  ) : null}

                  {platform === "tiktok" ? (
                    <>
                      {creatorLoading ? (
                        <LoadingState label="Loading TikTok creator controls…" />
                      ) : null}
                      {creatorInfo === null && !creatorLoading ? (
                        <Notice tone="warning">
                          {creatorError ??
                            "TikTok creator controls are unavailable. Recheck or reconnect this account before publishing."}
                        </Notice>
                      ) : null}
                      {capabilityFor("tiktok")?.mode === "private_only" ? (
                        <Notice tone="info">
                          This service is limited to TikTok’s Only me privacy
                          level.
                        </Notice>
                      ) : null}
                      {capabilityFor("tiktok")?.mode === "private_only" &&
                      creatorInfo !== null &&
                      !privateTikTokAccountEligible(creatorInfo) ? (
                        <Notice tone="danger">
                          TikTok’s unaudited Direct Post mode requires an
                          eligible private creator account. This account cannot
                          be submitted.
                        </Notice>
                      ) : null}
                      {creatorInfo === null ? null : (
                        <Notice tone="info">
                          Posting to the TikTok account owned by{" "}
                          <strong>{creatorInfo.creator_nickname}</strong>.
                        </Notice>
                      )}
                      <div className="field">
                        <label htmlFor="tiktok-title">Caption</label>
                        <textarea
                          className="textarea"
                          id="tiktok-title"
                          maxLength={2200}
                          onChange={event => {
                            setTiktokTitle(event.target.value);
                            setTiktokConsent(false);
                          }}
                          placeholder="Leave empty to use the shared caption"
                          rows={4}
                          value={tiktokTitle}
                        />
                        <span className="character-count">
                          {tiktokTitle.length}/2200
                        </span>
                      </div>
                      <div className="field">
                        <label htmlFor="tiktok-privacy">Who can view</label>
                        <select
                          className="select"
                          disabled={creatorInfo === null}
                          id="tiktok-privacy"
                          onChange={event => {
                            const privacy = event.target.value as TikTokPrivacy;
                            setTiktokPrivacy(privacy);
                            if (privacy === "SELF_ONLY") {
                              setTiktokBranded(false);
                            }
                            setTiktokConsent(false);
                          }}
                          required
                          value={tiktokPrivacy}>
                          <option value="">Choose privacy</option>
                          {(creatorInfo?.privacy_level_options ?? []).map(
                            option => (
                              <option key={option} value={option}>
                                {option.replaceAll("_", " ").toLowerCase()}
                              </option>
                            )
                          )}
                        </select>
                      </div>
                      <fieldset className="fieldset">
                        <legend>Interactions</legend>
                        <label className="check-row">
                          <input
                            checked={tiktokComments}
                            disabled={creatorInfo?.comment_disabled === true}
                            onChange={event => {
                              setTiktokComments(event.target.checked);
                              setTiktokConsent(false);
                            }}
                            type="checkbox"
                          />{" "}
                          Allow comments
                        </label>
                        <label className="check-row">
                          <input
                            checked={tiktokDuet}
                            disabled={creatorInfo?.duet_disabled === true}
                            onChange={event => {
                              setTiktokDuet(event.target.checked);
                              setTiktokConsent(false);
                            }}
                            type="checkbox"
                          />{" "}
                          Allow Duet
                        </label>
                        <label className="check-row">
                          <input
                            checked={tiktokStitch}
                            disabled={creatorInfo?.stitch_disabled === true}
                            onChange={event => {
                              setTiktokStitch(event.target.checked);
                              setTiktokConsent(false);
                            }}
                            type="checkbox"
                          />{" "}
                          Allow Stitch
                        </label>
                      </fieldset>
                      <fieldset className="fieldset">
                        <legend>Content disclosures</legend>
                        <label className="check-row">
                          <input
                            checked={tiktokAi}
                            onChange={event => {
                              setTiktokAi(event.target.checked);
                              setTiktokConsent(false);
                            }}
                            type="checkbox"
                          />{" "}
                          AI-generated content
                        </label>
                        <label className="check-row">
                          <input
                            checked={tiktokCommercialContent}
                            onChange={event => {
                              const enabled = event.target.checked;
                              setTiktokCommercialContent(enabled);
                              if (!enabled) {
                                setTiktokOwnBrand(false);
                                setTiktokBranded(false);
                              }
                              setTiktokConsent(false);
                            }}
                            type="checkbox"
                          />{" "}
                          This content promotes myself, a brand, product, or
                          service
                        </label>
                        {tiktokCommercialContent ? (
                          <div className="stack stack-tight">
                            <label className="check-row">
                              <input
                                checked={tiktokOwnBrand}
                                onChange={event => {
                                  setTiktokOwnBrand(event.target.checked);
                                  setTiktokConsent(false);
                                }}
                                type="checkbox"
                              />{" "}
                              Your brand
                            </label>
                            <label className="check-row">
                              <input
                                checked={tiktokBranded}
                                disabled={tiktokPrivacy === "SELF_ONLY"}
                                onChange={event => {
                                  setTiktokBranded(event.target.checked);
                                  setTiktokConsent(false);
                                }}
                                type="checkbox"
                              />{" "}
                              Branded content
                            </label>
                            {!tiktokOwnBrand && !tiktokBranded ? (
                              <Notice tone="warning">
                                Choose Your brand, Branded content, or both to
                                continue.
                              </Notice>
                            ) : null}
                            {tiktokBranded ? (
                              <Notice tone="info">
                                Your video will be labeled as “Paid
                                partnership”.
                              </Notice>
                            ) : tiktokOwnBrand ? (
                              <Notice tone="info">
                                Your video will be labeled as “Promotional
                                content”.
                              </Notice>
                            ) : null}
                            {tiktokPrivacy === "SELF_ONLY" ? (
                              <Notice tone="info">
                                Branded content cannot use Only me visibility.
                              </Notice>
                            ) : null}
                          </div>
                        ) : null}
                      </fieldset>
                      <div className="check-row">
                        <input
                          aria-describedby="tiktok-consent-policy"
                          checked={tiktokConsent}
                          id="tiktok-consent"
                          onChange={event =>
                            setTiktokConsent(event.target.checked)
                          }
                          required
                          type="checkbox"
                        />{" "}
                        <label htmlFor="tiktok-consent">
                          Confirm TikTok publishing consent.
                        </label>
                      </div>
                      <p className="form-help" id="tiktok-consent-policy">
                        By posting, you agree to TikTok’s{" "}
                        {tiktokBranded ? (
                          <>
                            <a
                              href="https://www.tiktok.com/legal/page/global/bc-policy/en"
                              rel="noreferrer"
                              target="_blank">
                              Branded Content Policy
                            </a>{" "}
                            and{" "}
                          </>
                        ) : null}
                        <a
                          href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
                          rel="noreferrer"
                          target="_blank">
                          Music Usage Confirmation
                        </a>
                        .
                      </p>
                      <Notice tone="info">
                        TikTok may take a few minutes to process the video and
                        make it visible on your profile after submission.
                      </Notice>
                    </>
                  ) : null}
                </div>
              </details>
            );
          })}

          <section className="panel stack" aria-labelledby="rights-heading">
            <h2 id="rights-heading">4. Confirm rights and submit</h2>
            <label className="check-row">
              <input
                checked={rightsConfirmed}
                onChange={event => setRightsConfirmed(event.target.checked)}
                required
                type="checkbox"
              />
              I own or have permission to publish this video, audio, caption,
              and any included brands to every selected destination.
            </label>
          </section>
        </div>

        <aside
          className="compose-summary panel stack"
          aria-labelledby="summary-heading">
          <div>
            <p className="eyebrow">Review</p>
            <h2 id="summary-heading">Submission summary</h2>
          </div>
          <div className="summary-list">
            <div className="summary-row">
              <span>Media</span>
              <strong>
                {upload === null ? "Not verified" : upload.filename}
              </strong>
            </div>
            <div className="summary-row">
              <span>Destinations</span>
              <strong>{selectedPlatforms.length}</strong>
            </div>
            <div className="summary-row">
              <span>Delivery</span>
              <strong>Immediately</strong>
            </div>
          </div>
          {selectedPlatforms.map(platform => (
            <div className="cluster" key={platform}>
              <PlatformMark platform={platform} />
              <span>{platformLabels[platform]}</span>
            </div>
          ))}
          {selectedPlatforms.length === 0 ? (
            <Notice tone="warning">
              Choose at least one publishable destination.
            </Notice>
          ) : null}
          <Button
            busy={busy}
            disabled={
              upload === null ||
              selectedPlatforms.length === 0 ||
              !rightsConfirmed ||
              (selected.tiktok !== undefined &&
                (creatorInfo === null ||
                  creatorLoading ||
                  effectiveTikTokPrivacy === null ||
                  !tiktokConsent ||
                  (tiktokCommercialContent &&
                    !tiktokOwnBrand &&
                    !tiktokBranded) ||
                  (effectiveTikTokPrivacy === "SELF_ONLY" && tiktokBranded) ||
                  (upload !== null &&
                    upload.durationMs !== null &&
                    creatorInfo !== null &&
                    upload.durationMs / 1000 >
                      creatorInfo.max_video_post_duration_sec) ||
                  (capabilityFor("tiktok")?.mode === "private_only" &&
                    !privateTikTokAccountEligible(creatorInfo))))
            }
            type="submit"
            wide>
            <Send aria-hidden="true" size={17} /> Submit post
          </Button>
          <p className="form-help">
            Submission queues a separate provider job for each destination. A
            partial success is not reported as fully published.
          </p>
        </aside>
      </div>
    </form>
  );
}
