import { handle, httpError } from "../server/http.js";
import { tillStaff, processReturn, approveDiscount } from "../server/till.js";

// Till actions for signed-in staff: returns, voids and discount approvals. Each one re-checks permissions on the server.
export default handle(async (req) => {
  const staff = await tillStaff(req);
  const action = req.body?.action;
  if (action === "return") return processReturn(staff, req.body);
  if (action === "discount-approval") return approveDiscount(staff, req.body);
  throw httpError(400, "Unknown till action.");
});
