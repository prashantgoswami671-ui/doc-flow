# ai_assistant.py - Reusable AI Assistant Module

from dotenv import load_dotenv
load_dotenv()  # Loads the .env file automatically

from openai import OpenAI
import os

class AIAssistant:
    """A reusable AI coding assistant using NVIDIA's Nemotron model."""
    
    def __init__(self, api_key=None, model="nvidia/nemotron-3-ultra-550b-a55b"):
        """
        Initialize the AI assistant.
        
        Args:
            api_key: Your NVIDIA API key (optional, will look for env var)
            model: The model to use (default: nvidia/nemotron-3-ultra-550b-a55b)
        """
        if api_key is None:
            api_key = os.getenv("NVIDIA_API_KEY")
            if api_key is None:
                raise ValueError("API key not found. Set NVIDIA_API_KEY environment variable or pass it directly.")
        
        self.client = OpenAI(
            base_url="https://integrate.api.nvidia.com/v1",
            api_key=api_key
        )
        self.model = model
    
    def ask(self, prompt, temperature=0.3, max_tokens=8192, thinking=True):
        """
        Send a prompt to the AI and get a response.
        
        Args:
            prompt: Your question or code request
            temperature: 0-1, lower = more focused (0.2-0.4 for code)
            max_tokens: Maximum response length
            thinking: Enable reasoning trace
            
        Returns:
            The AI's response text
        """
        completion = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
            top_p=0.95,
            max_tokens=max_tokens,
            extra_body={"chat_template_kwargs": {"enable_thinking": thinking}}
        )
        return completion.choices[0].message.content
    
    def ask_with_context(self, messages, temperature=0.3, max_tokens=8192):
        """
        Send a conversation history to the AI.
        
        Args:
            messages: List of message dicts [{"role": "user", "content": "..."}, ...]
            temperature: 0-1
            max_tokens: Maximum response length
            
        Returns:
            The AI's response text
        """
        completion = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=temperature,
            top_p=0.95,
            max_tokens=max_tokens,
            extra_body={"chat_template_kwargs": {"enable_thinking": True}}
        )
        return completion.choices[0].message.content


# Helper function for quick one-off queries
def quick_ask(prompt, api_key=None):
    """Quick one-liner to ask the AI something."""
    assistant = AIAssistant(api_key)
    return assistant.ask(prompt)


# Test the module when run directly
if __name__ == "__main__":
    print("🤖 AI Assistant Module Loaded Successfully!")
    print("To use it, import AIAssistant in your project.")