import React from "react";
import { Message, Tool, ToolInvocation } from "../controller/AIController";
import { usePlugin } from "../providers/PluginProvider";

export function useChat(tools?: Tool[]) {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const { llm } = usePlugin();

  const append = (appendMessages: Message[]) => {
    llm.getSteamedText([...messages, ...appendMessages], (id, message, finished: boolean, toolInvocations?: ToolInvocation[]) => {
      const lastMessage = messages[messages.length - 1];
      setIsLoading(!finished);

      if (lastMessage?.id === id) {
        lastMessage.content = message;
        setMessages([...messages, lastMessage]);
      } else {
        setMessages([...messages, ...appendMessages, { id, role: 'assistant', content: message, toolInvocations }]);
      }
    }, tools);
  };

  return { messages, append, isLoading, setMessages, lastMessage: messages[messages.length - 1] as Message | undefined };
}
