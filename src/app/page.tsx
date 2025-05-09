"use client";

import { useState, useEffect, useRef, FormEvent, KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

interface SourceContent {
  id: string;
  type: string;
  text: string;
}

interface Source {
  file_id: string;
  filename: string;
  score?: number;
  attributes?: Record<string, unknown>; // Using unknown instead of any for better type safety
  content?: SourceContent[];
}

interface Message {
  id: string;
  text: string;
  sender: "user" | "ai";
  sources?: Source[];
}

const MAX_HISTORY_MESSAGES = 4; // Number of past messages to include in context

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [lastMessageWasUser, setLastMessageWasUser] = useState(false);

  const handleNewChat = () => {
    setMessages([]);
    setInput("");
    setError(null);
    setIsLoading(false);
    setLastMessageWasUser(false);
    setIsAtBottom(true);
  };

  const checkScrollPosition = () => {
    const scrollableViewport = scrollAreaRef.current?.querySelector("[data-radix-scroll-area-viewport]");
    if (scrollableViewport) {
      const { scrollTop, scrollHeight, clientHeight } = scrollableViewport;
      // Consider at bottom if within a small threshold (e.g., 10 pixels)
      setIsAtBottom(scrollHeight - scrollTop - clientHeight < 10);
    }
  };

  const scrollToBottom = (force: boolean = false) => {
    if (scrollAreaRef.current) {
      const scrollableViewport = scrollAreaRef.current.querySelector("[data-radix-scroll-area-viewport]");
      if (scrollableViewport && (force || isAtBottom || lastMessageWasUser)) {
        scrollableViewport.scrollTop = scrollableViewport.scrollHeight;
      }
    }
  };

  useEffect(() => {
    // Listen to scroll events on the viewport to update isAtBottom
    const scrollableViewport = scrollAreaRef.current?.querySelector("[data-radix-scroll-area-viewport]");
    if (scrollableViewport) {
      scrollableViewport.addEventListener("scroll", checkScrollPosition);
      checkScrollPosition(); // Initial check
      return () => scrollableViewport.removeEventListener("scroll", checkScrollPosition);
    }
  }, []);

  useEffect(() => {
    // Scroll to bottom if the user just sent a message, or if they are already at the bottom
    if (messages.length > 0 && (messages[messages.length - 1].sender === "user" || isAtBottom)) {
      scrollToBottom(messages[messages.length - 1].sender === "user");
    }
    if (messages.length > 0) {
      setLastMessageWasUser(messages[messages.length - 1].sender === "user");
    }
  }, [messages]);

  const handleStreamedResponse = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    aiMessageId: string
  ) => {
    let accumulatedResponse = "";
    let lastEventData = "";

    const processChunk = () => {
      // This ensures that if user was at bottom when AI starts replying,
      // and AI reply grows beyond viewport, it keeps scrolling.
      if (isAtBottom) {
        scrollToBottom();
      }
    };

    while (true) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) {
        if (lastEventData.startsWith("data: ")) {
          const jsonData = lastEventData.substring(6).trim();
          if (jsonData) {
            try {
              const parsed = JSON.parse(jsonData);
              if (parsed.response) {
                accumulatedResponse += parsed.response;
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === aiMessageId ? { ...msg, text: accumulatedResponse, sources: parsed.data || [] } : msg
                  )
                );
                processChunk();
              }
            } catch (e) {
              console.warn("Failed to parse final JSON from stream after done:", jsonData, e);
            }
          }
        }
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      lastEventData += chunk;

      let eventBoundary = lastEventData.indexOf("\n\n");
      while (eventBoundary !== -1) {
        const eventStr = lastEventData.substring(0, eventBoundary);
        lastEventData = lastEventData.substring(eventBoundary + 2);

        if (eventStr.startsWith("data: ")) {
          const jsonData = eventStr.substring(6).trim();
          if (jsonData) {
            try {
              const parsed = JSON.parse(jsonData);
              if (parsed.response) {
                accumulatedResponse += parsed.response;
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === aiMessageId ? { ...msg, text: accumulatedResponse, sources: parsed.data || [] } : msg
                  )
                );
                processChunk();
              } else if (parsed.token) {
                accumulatedResponse += parsed.token;
                setMessages((prev) =>
                  prev.map((msg) => (msg.id === aiMessageId ? { ...msg, text: accumulatedResponse } : msg))
                );
                processChunk();
              }
            } catch (e) {
              console.warn("Failed to parse JSON from stream chunk:", jsonData, e);
            }
          }
        }
        eventBoundary = lastEventData.indexOf("\n\n");
      }
    }
  };

  const handleSubmit = async (e?: FormEvent<HTMLFormElement> | KeyboardEvent<HTMLInputElement>) => {
    if (e) e.preventDefault();
    const currentInput = input.trim();
    if (!currentInput || isLoading) return;

    setLastMessageWasUser(true); // User is sending a message
    checkScrollPosition(); // Check if user is at bottom before adding message

    const userMessage: Message = { id: Date.now().toString(), text: currentInput, sender: "user" };
    const currentMessagesForHistory = [...messages];

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setError(null);

    let queryWithHistory = "";
    const historyToInclude = currentMessagesForHistory.slice(-MAX_HISTORY_MESSAGES);

    if (historyToInclude.length > 0) {
      queryWithHistory += "Previous conversation:\n";
      historyToInclude.forEach((msg) => {
        queryWithHistory += `${msg.sender === "user" ? "User" : "AI"}: ${msg.text}\n`;
      });
      queryWithHistory += "\n";
    }
    queryWithHistory += `Current query: ${currentInput}`;

    const aiMessageId = (Date.now() + 1).toString();
    setMessages((prev) => [...prev, { id: aiMessageId, text: "", sender: "ai" }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: queryWithHistory }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: `API Error: ${response.statusText}` }));
        throw new Error(errData.error || `API Error: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("No response body from server");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      await handleStreamedResponse(reader, decoder, aiMessageId);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("Chat submission error:", error);
      setError(error.message || "Failed to get response from AI.");
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === aiMessageId ? { ...msg, text: "Sorry, I couldn't get a response.", sources: [] } : msg
        )
      );
    } finally {
      setIsLoading(false);
      setLastMessageWasUser(false); // Reset after AI response cycle is complete
    }
  };

  const handleKeyPress = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      handleSubmit(e);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900 p-4">
      <Card className="w-full max-w-5xl shadow-xl flex flex-col h-[calc(100vh-80px)] max-h-[700px]">
        <CardHeader className="flex flex-row justify-between items-center">
          <CardTitle className="text-2xl font-bold">ChatRAG</CardTitle>
          <Button variant="outline" size="sm" onClick={handleNewChat} disabled={isLoading && messages.length > 0}>
            New Chat
          </Button>
        </CardHeader>
        <CardContent className="flex-grow overflow-hidden p-0">
          <ScrollArea className="h-full w-full p-4 bg-white dark:bg-gray-800" ref={scrollAreaRef}>
            {messages.map((msg) => (
              <div key={msg.id} className={`flex mb-4 ${msg.sender === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`flex flex-col leading-1.5 rounded-xl 
                            ${
                              msg.sender === "user"
                                ? "bg-blue-600 text-white rounded-tr-none w-fit max-w-[calc(100%-50px)] sm:max-w-md md:max-w-xl lg:max-w-3xl p-3"
                                : "text-gray-900 dark:text-gray-100 rounded-tl-none w-full max-w-[calc(100%-50px)] sm:max-w-md md:max-w-xl lg:max-w-3xl py-3"
                            }`}
                >
                  {msg.sender === "ai" ? (
                    <div className="text-sm text-gray-900 dark:text-white max-w-none break-words min-w-0 w-full">
                      {msg.text ? (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            h1: (props) => <h1 className="text-2xl font-bold my-4 w-full" {...props} />,
                            h2: (props) => <h2 className="text-xl font-bold my-3 w-full" {...props} />,
                            h3: (props) => <h3 className="text-lg font-bold my-2 w-full" {...props} />,
                            p: (props) => <p className="mb-2 w-full" {...props} />,
                            ul: (props) => <ul className="list-disc list-inside mb-2 pl-4 w-full" {...props} />,
                            ol: (props) => <ol className="list-decimal list-inside mb-2 pl-4 w-full" {...props} />,
                            li: (props) => <li className="mb-1 w-full" {...props} />,
                            a: (props) => <a className="text-blue-600 hover:underline dark:text-blue-400" {...props} />,
                            /* @ts-expect-error Fix later*/
                            code: ({
                              inline,
                              className,
                              children,
                              ...props
                            }: {
                              inline?: boolean;
                              className?: string;
                              children?: React.ReactNode;
                              [key: string]: unknown;
                            }) => {
                              const match = /language-(\w+)/.exec(className || "");
                              return !inline && match ? (
                                <pre className="bg-gray-100 dark:bg-gray-800 p-2 rounded-md my-2 overflow-x-auto w-full">
                                  <code className={className} {...props}>
                                    {children}
                                  </code>
                                </pre>
                              ) : (
                                <code
                                  className={`bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded-sm font-mono text-sm ${
                                    className || ""
                                  }`}
                                  {...props}
                                >
                                  {children}
                                </code>
                              );
                            },
                            blockquote: (props) => (
                              <blockquote
                                className="border-l-4 border-gray-300 dark:border-gray-600 pl-3 italic my-2 w-full"
                                {...props}
                              />
                            ),
                          }}
                        >
                          {msg.text}
                        </ReactMarkdown>
                      ) : isLoading &&
                        msg.id === messages[messages.length - 1]?.id &&
                        messages[messages.length - 1]?.sender === "ai" ? (
                        <div className="flex items-center justify-start space-x-1 py-1">
                          <div className="h-2 w-2 bg-current rounded-full animate-pulse [animation-delay:-0.3s]"></div>
                          <div className="h-2 w-2 bg-current rounded-full animate-pulse [animation-delay:-0.15s]"></div>
                          <div className="h-2 w-2 bg-current rounded-full animate-pulse"></div>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-sm font-normal whitespace-pre-wrap break-words">{msg.text}</p>
                  )}

                  {msg.sender === "ai" && msg.sources && msg.sources.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-300 dark:border-gray-600">
                      <p className="text-xs font-semibold mb-1">Sources:</p>
                      <ul className="list-disc list-inside text-xs">
                        {msg.sources.map((source, index) => (
                          <li key={index} title={`Score: ${source.score?.toFixed(4)}`}>
                            {source.filename} (ID: {source.file_id})
                            {source.content?.[0]?.text && (
                              <p className="text-xs italic truncate">{`"${source.content[0].text}"`}</p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </ScrollArea>
        </CardContent>
        <CardFooter className="p-4 border-t">
          {error && <p className="text-red-500 text-sm pb-2 text-center w-full">Error: {error}</p>}
          <form onSubmit={handleSubmit} className="flex w-full items-center space-x-2">
            <Input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message..."
              className="flex-1"
              disabled={isLoading}
              onKeyDown={handleKeyPress}
            />
            <Button type="submit" disabled={isLoading || !input.trim()}>
              {isLoading ? "Sending..." : "Send"}
            </Button>
          </form>
        </CardFooter>
      </Card>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">Powered by Cloudflare AutoRAG.</p>
    </div>
  );
}
