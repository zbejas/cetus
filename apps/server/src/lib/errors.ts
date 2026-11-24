export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function jsonError(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json(
      {
        type: "about:blank",
        title: error.code,
        status: error.status,
        detail: error.message,
        code: error.code,
        details: error.details,
      },
      { status: error.status },
    );
  }
  console.error(error);
  return Response.json(
    {
      type: "about:blank",
      title: "internal_error",
      status: 500,
      detail: error instanceof Error ? error.message : "Internal server error",
      code: "internal_error",
    },
    { status: 500 },
  );
}
