const loginForm = document.querySelector("#loginForm");
const loginMessage = document.querySelector("#loginMessage");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginMessage.textContent = "";

  const formData = new FormData(loginForm);
  const payload = {
    username: String(formData.get("username") || ""),
    password: String(formData.get("password") || "")
  };

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || "Login failed.");
    }

    window.location.href = "/";
  } catch (error) {
    loginMessage.textContent = error.message;
  }
});
