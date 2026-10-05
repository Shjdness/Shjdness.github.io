import Editor from '@monaco-editor/react';
import i18n from 'i18next';
import _ from 'lodash';
import { editor } from 'monaco-editor';
import { Calendar } from 'primereact/calendar';
import 'primereact/resources/primereact.css';
import 'primereact/resources/themes/lara-light-indigo/theme.css';
import React, { useEffect, useRef, useState, useCallback } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import Loading from 'react-loading';
import { ShowAlertType, useAlert } from '../components/dialog';
import { Input } from "../components/input";
import { Markdown } from "../components/markdown";
import { client } from "../main";
import { headersWithAuth } from "../utils/auth";
import { Cache, useCache } from '../utils/cache';
import { siteName } from "../utils/constants";
import { useColorMode } from "../utils/darkModeUtils";
import mermaid from 'mermaid';
import { readingStats } from '../utils/reading';

type ContentKind = 'article' | 'essay' | 'diary' | 'memo';

function uploadImage(file: File, onSuccess: (url: string) => void, showAlert: ShowAlertType) {
  const t = i18n.t
  client.storage.index
    .post(
      {
        key: file.name,
        file: file,
      },
      {
        headers: headersWithAuth(),
      }
    )
    .then(({ data, error }) => {
      if (error) {
        showAlert(t("upload.failed", { error: error.value }));
      }
      if (data) {
        onSuccess(data);
      }
    })
    .catch((e: any) => {
      console.error(e);
      showAlert(t("upload.failed", { error: e.message }));
    });
}



// 写作页面
export function WritingPage({ id }: { id?: number }) {
  const { t } = useTranslation();
  const colorMode = useColorMode();
  const cache = Cache.with(id);
  const editorRef = useRef<editor.IStandaloneCodeEditor>();
  const [title, setTitle] = cache.useCache("title", "");
  const [summary, setSummary] = cache.useCache("summary", "");
  const [tags, setTags] = cache.useCache("tags", "");
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [tagQuery, setTagQuery] = useState('');
  const [alias, setAlias] = cache.useCache("alias", "");
  const [kind, setKind] = useState<ContentKind>('article');
  const [currentId, setCurrentId] = useState<number | undefined>(id);
  const [saveState, setSaveState] = useState('本地已保存');
  const [content, setContent] = cache.useCache("content", "");
  const [createdAt, setCreatedAt] = useState<Date | undefined>(new Date());
  const [preview, setPreview] = useCache<'edit' | 'preview' | 'comparison'>("preview", 'edit');
  const [uploading, setUploading] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const { showAlert, AlertUI } = useAlert()
  const stats = readingStats(content)

  const selectedTagNames = tags.split('#').map(tag => tag.trim()).filter(Boolean);
  const privateMode = kind === 'diary' || kind === 'memo';
  const saveTagNames = (names: string[]) => {
    const unique = [...new Set(names.map(name => name.trim().replace(/^#/, '')).filter(Boolean))];
    setTags(unique.map(name => `#${name}`).join(' '));
  };
  const toggleTag = (name: string) => {
    saveTagNames(selectedTagNames.includes(name)
      ? selectedTagNames.filter(tag => tag !== name)
      : [...selectedTagNames, name]);
  };
  const addTypedTag = () => {
    const name = tagQuery.trim().replace(/^#/, '');
    if (!name) return;
    saveTagNames([...selectedTagNames, name]);
    setTagQuery('');
  };

  function applyHeading(level: 1 | 2 | 3) {
    const currentEditor = editorRef.current
    const selection = currentEditor?.getSelection()
    const model = currentEditor?.getModel()
    if (!currentEditor || !selection || !model) return
    const line = selection.startLineNumber
    const currentText = model.getLineContent(line).replace(/^#{1,6}\s*/, '')
    currentEditor.executeEdits('heading-toolbar', [{
      range: {
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: model.getLineMaxColumn(line),
      },
      text: `${'#'.repeat(level)} ${currentText}`,
    }])
    currentEditor.focus()
  }
  async function publishButton() {
    if (publishing) return;
    const tagsplit =
      tags
        .split("#")
        .filter((tag) => tag !== "")
        .map((tag) => tag.trim()) || [];
    if (!title.trim()) { showAlert(t("title_empty")); return; }
    if (!content.trim()) { showAlert(t("content.empty")); return; }
    setPublishing(true);
    try {
      const payload = { title: title.trim(), content, summary, alias, tags: tagsplit, draft: false, kind, listed: !privateMode, createdAt };
      let publishedId = currentId;
      if (currentId !== undefined) {
        const { error } = await client.feed({ id: currentId }).post(payload, { headers: headersWithAuth() });
        if (error) throw new Error(typeof error.value === 'string' ? error.value : JSON.stringify(error.value));
      } else {
        const { data, error } = await client.feed.index.post(payload, { headers: headersWithAuth() });
        if (error || !data || typeof data === 'string') throw new Error(error ? JSON.stringify(error.value) : '发布失败');
        publishedId = data.insertedId;
      }
      Cache.with().clear();
      if (publishedId !== undefined) Cache.with(publishedId).clear();
      const destination = kind === 'memo' ? '/blog/memos' : kind === 'diary' ? '/blog/diary' : `/blog/feed/${publishedId}`;
      showAlert(currentId === undefined ? t('publish.success') : t('update.success'), () => { window.location.href = destination; });
    } catch (error) {
      showAlert(error instanceof Error ? error.message : '发布失败，请稍后重试');
    } finally {
      setPublishing(false);
    }
  }

  async function saveDraftToCloud() {
    if (publishing) return;
    setPublishing(true); setSaveState('正在上传草稿…');
    const payload = { title: title.trim() || '未命名草稿', content, summary, alias, tags: selectedTagNames, draft: true, kind, listed: false, createdAt };
    try {
      if (currentId !== undefined) {
        const { error } = await client.feed({ id: currentId }).post(payload, { headers: headersWithAuth() });
        if (error) throw new Error(String(error.value));
      } else {
        const { data, error } = await client.feed.index.post(payload, { headers: headersWithAuth() });
        if (error || !data || typeof data === 'string') throw new Error(error ? String(error.value) : '草稿保存失败');
        setCurrentId(data.insertedId); window.history.replaceState({}, '', `/blog/writing/${data.insertedId}`);
      }
      setSaveState(`云端已备份 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '云端备份失败，本地稿仍保留';
      setSaveState(message);
      showAlert(message);
    }
    finally { setPublishing(false); }
  }


  const handlePaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    // Access the clipboard data using event.clipboardData
    const clipboardData = event.clipboardData;
    // only if clipboard payload is file
    if (clipboardData.files.length === 1) {
      const editor = editorRef.current;
      if (!editor) return;
      editor.trigger(undefined, "undo", undefined);
      setUploading(true)
      const myfile = clipboardData.files[0] as File;
      uploadImage(myfile, (url) => {
        const selection = editor.getSelection();
        if (!selection) return;
        editor.executeEdits(undefined, [{
          range: selection,
          text: `![${myfile.name}](${url})\n`,
        }]);
        setUploading(false)
      }, showAlert);
    }
  };

  function UploadImageButton() {
    const { showAlert, AlertUI } = useAlert();
    const uploadRef = useRef<HTMLInputElement>(null);
    const t = i18n.t
    const upChange = (event: any) => {
      for (let i = 0; i < event.currentTarget.files.length; i++) {
        const file = event.currentTarget.files[i]; ///获得input的第一个图片
        if (file.size > 5 * 1024000) {
          showAlert(t("upload.failed$size", { size: 5 }))
          uploadRef.current!.value = "";
        } else {
          const editor = editorRef.current;
          if (!editor) return;
          const selection = editor.getSelection();
          if (!selection) return;
          setUploading(true)
          uploadImage(file, (url) => {
            setUploading(false)
            editor.executeEdits(undefined, [{
              range: selection,
              text: `![${file.name}](${url})\n`,
            }]);
          }, showAlert);
        }
      }
    };
    return (
      <button onClick={() => uploadRef.current?.click()}>
        <input
          ref={uploadRef}
          onChange={upChange}
          className="hidden"
          type="file"
          accept="image/gif,image/jpeg,image/jpg,image/png"
        />
        <i className="ri-image-add-line" />
        <AlertUI />
      </button>
    )
  }
  useEffect(() => {
    if (id) {
      client
        .feed({ id })
        .get({
          headers: headersWithAuth(),
        })
        .then(({ data }) => {
          if (data && typeof data !== "string") {
            setTitle(data.title || '');
            setTags(data.hashtags?.map(({ name }) => `#${name}`).join(" ") || '');
            setAlias(data.alias || '');
            setContent(data.content || '');
            setSummary(data.summary || '');
            setKind((['article', 'essay', 'diary', 'memo'].includes(data.kind) ? data.kind : 'article') as ContentKind);
            setCreatedAt(new Date(data.createdAt));
            setSaveState(data.draft === 1 ? '已从云端载入草稿' : '已从云端载入');
          }
        });
    }
  }, []);
  useEffect(() => {
    client.tag.index.get({ query: { kind } }).then(({ data }) => {
      if (data && typeof data !== 'string') {
        setAvailableTags(data.filter(tag => tag.feeds > 0).map(tag => tag.name));
      }
    });
  }, [kind]);
  const debouncedUpdate = useCallback(
    _.debounce(() => {
      mermaid.initialize({
        startOnLoad: false,
        theme: "default",
      });
      mermaid.run({
        suppressErrors: true,
        nodes: document.querySelectorAll("pre.mermaid_default")
      }).then(()=>{
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
        });
        mermaid.run({
          suppressErrors: true,
          nodes: document.querySelectorAll("pre.mermaid_dark")
        });
      })
    }, 100),
    []
  );
  useEffect(() => {
    debouncedUpdate();
  }, [content, debouncedUpdate]);
  function MetaInput({ className }: { className?: string }) {
    return (
      <>
        <div className={className}>
          <Input
            id={id}
            value={title}
            setValue={setTitle}
            placeholder={t("title")}
          />
          <label className="writing-kind mt-4">
            <span>内容类型</span>
            <select value={kind} onChange={event => setKind(event.target.value as ContentKind)}>
              <option value="article">普通文章</option>
              <option value="essay">随笔</option>
              <option value="diary">私人日记</option>
              <option value="memo">备忘录</option>
            </select>
          </label>
          <Input
            id={id}
            value={summary}
            setValue={setSummary}
            placeholder={t("summary")}
            className="mt-4"
          />
          <div className="tag-picker mt-4">
            <div className="tag-picker-heading">
              <span>{t('tags')}</span>
              <small>可多选；输入新词条后按回车即可创建</small>
            </div>
            <div className="tag-picker-options">
              {availableTags.map(name => (
                <button type="button" key={name} onClick={() => toggleTag(name)}
                  className={selectedTagNames.includes(name) ? 'is-selected' : ''}>
                  #{name}
                </button>
              ))}
              {availableTags.length === 0 && <span className="tag-picker-empty">还没有已有标签</span>}
            </div>
            <div className="tag-picker-create">
              <input value={tagQuery} placeholder="输入新标签" onChange={event => setTagQuery(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addTypedTag(); } }} />
              <button type="button" onClick={addTypedTag} disabled={!tagQuery.trim()}>添加</button>
            </div>
            {selectedTagNames.length > 0 && <p className="tag-picker-selected">已选：{selectedTagNames.map(name => `#${name}`).join('  ')}</p>}
          </div>
          <Input
            id={id}
            value={alias}
            setValue={setAlias}
            placeholder={t("alias")}
            className="mt-4"
          />
          <div className="select-none flex flex-row justify-between items-center mt-4 mb-2 pl-4">
            <p className="break-keep mr-2">
              {t('created_at')}
            </p>
            <Calendar value={createdAt} onChange={(e) => setCreatedAt(e.value || undefined)} showTime touchUI hourFormat="24" />
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Helmet>
        <title>{`${t('writing')} - ${process.env.NAME}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={t('writing')} />
        <meta property="og:image" content={process.env.AVATAR} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={document.URL} />
      </Helmet>
      <div className="grid grid-cols-1 md:grid-cols-3 t-primary mt-2">
        <div className="col-span-2 pb-8">
          <div className="glass-panel bg-w rounded-2xl shadow-xl shadow-light p-4">
            {MetaInput({ className: "visible md:hidden mb-8" })}
            <div className="flex flex-col mx-4 my-2 md:mx-0 md:my-0 gap-2">
              <div className="flex flex-row flex-wrap items-center gap-2">
                <button className={`${preview === 'edit' ? "text-theme" : ""}`} onClick={() => setPreview('edit')}> {t("edit")} </button>
                <button className={`${preview === 'preview' ? "text-theme" : ""}`} onClick={() => setPreview('preview')}> {t("preview")} </button>
                <button className={`${preview === 'comparison' ? "text-theme" : ""}`} onClick={() => setPreview('comparison')}> {t("comparison")} </button>
                <span className="h-4 w-px bg-neutral-400/40" aria-hidden="true" />
                {[1, 2, 3].map(level => (
                  <button
                    key={level}
                    type="button"
                    className="editor-heading-button"
                    title={t('writing_help.heading', { level })}
                    onClick={() => applyHeading(level as 1 | 2 | 3)}
                  >
                    {'#'.repeat(level)}
                  </button>
                ))}
                <span className="text-xs t-secondary">
                  {t('reading.stats', { count: stats.characters, minutes: stats.minutes })}
                </span>
                <div className="flex-grow" />
                {uploading &&
                  <div className="flex flex-row space-x-2 items-center">
                    <Loading type="spin" color="#FC466B" height={16} width={16} />
                    <span className="text-sm text-neutral-500">{t('uploading')}</span>
                  </div>
                }
              </div>
              <div className={`grid grid-cols-1 ${preview === 'comparison' ? "sm:grid-cols-2" : ""}`}>
                <div className={"flex flex-col " + (preview === 'preview' ? "hidden" : "")}>
                  <div className="flex flex-row justify-start mb-2">
                    <UploadImageButton />
                  </div>
                  <div
                    className={"relative"}
                    onDrop={(e) => {
                      e.preventDefault();
                      const editor = editorRef.current;
                      if (!editor) return;
                      for (let i = 0; i < e.dataTransfer.files.length; i++) {
                        const selection = editor.getSelection();
                        if (!selection) return;
                        const file = e.dataTransfer.files[i];
                        setUploading(true)
                        uploadImage(file, (url) => {
                          setUploading(false)
                          editor.executeEdits(undefined, [{
                            range: selection,
                            text: `![${file.name}](${url})\n`,
                          }]);
                        }, showAlert);
                      }
                    }}
                    onPaste={handlePaste}
                  >
                    <Editor
                      onMount={(editor, _) => {
                        editorRef.current = editor
                      }}
                      height="600px"
                      defaultLanguage="markdown"
                      className=""
                      value={content}
                      // onPaste={handlePaste}
                      onChange={(data, _) => {
                        cache.set("content", data ?? "");
                        setContent(data ?? "");
                      }}
                      theme={colorMode === "dark" ? "vs-dark" : "light"}
                      options={{
                        wordWrap: "on",
                        fontSize: 14,
                        fontFamily: "Fira Code",
                        lineNumbers: "off",
                        dragAndDrop: true,
                        pasteAs: { enabled: false }
                      }}
                    />
                  </div>
                </div>
                <div
                  className={"px-4 h-[600px] overflow-y-scroll " + (preview !== 'edit' ? "" : "hidden")}
                >
                  <Markdown content={content ? content : "> No content now. Write on the left side."} />
                </div>
              </div>
            </div>
          </div>
          <div className="visible md:hidden flex flex-row justify-center gap-3 mt-8">
            <button onClick={() => void saveDraftToCloud()} className="basis-1/2 writing-save-draft">保存草稿</button>
            <button
              onClick={publishButton}
              className="basis-1/2 bg-theme text-white py-4 rounded-full shadow-xl shadow-light flex flex-row justify-center items-center space-x-2"
            >
              {publishing &&
                <Loading type="spin" height={16} width={16} />
              }
              <span>
                {t('publish.title')}
              </span>
            </button>
          </div>
        </div>
        <div className="hidden md:visible max-w-96 md:flex flex-col">
          {MetaInput({ className: "glass-panel bg-w rounded-2xl shadow-xl shadow-light p-4 mx-8" })}
          <div className="writing-save-state">{saveState}</div>
          <div className="flex flex-row justify-center gap-3 mt-4">
            <button onClick={() => void saveDraftToCloud()} className="basis-1/2 writing-save-draft">保存草稿</button>
            <button
              onClick={publishButton}
              className="basis-1/2 bg-theme text-white py-4 rounded-full shadow-xl shadow-light flex flex-row justify-center items-center space-x-2"
            >
              {publishing &&
                <Loading type="spin" height={16} width={16} />
              }
              <span>
                {t('publish.title')}
              </span>
            </button>
          </div>
        </div>
      </div>
      <AlertUI />
    </>

  );
}
